/**
 * Host-side system sampling for the Aurora floating orb.
 *
 * Every reading is a pure function over `/proc` (Linux) or `node:os` (any
 * platform), and the sampler keeps only the previous CPU tick so percentages
 * come from deltas. Nothing here throws: a metric that cannot be read reports
 * `null` so the UI drops the row instead of inventing a number.
 * @module aurora-system-stats/host/sampler
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs, statfsSync } from 'node:fs'
import os from 'node:os'
import type {
  DiskInfo,
  MemoryInfo,
  SwapInfo,
  SystemStatsSnapshot,
} from '../types.js'

export type { DiskInfo, MemoryInfo, SwapInfo, SystemStatsSnapshot }

interface CpuTimes {
  readonly idle: number
  readonly total: number
}

interface ProcStat {
  readonly cpu: CpuTimes | null
  readonly cores: readonly CpuTimes[]
}

/** Filesystems that are virtual, container-internal, or otherwise noise in a UI list. */
const VIRTUAL_FS = new Set([
  'devtmpfs', 'devpts', 'tmpfs', 'ramfs', 'proc', 'sysfs', 'cgroup', 'cgroup2',
  'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'mqueue', 'hugetlbfs',
  'configfs', 'fusectl', 'autofs', 'binfmt_misc', 'nsfs', 'rpc_pipefs',
  'selinuxfs', 'efivarfs', 'squashfs', 'fuse.lxcfs', 'fuse.gvfsd-fuse',
  'overlay',
])

/** Mount-point prefixes that never belong in a "how full is my machine" list. */
const VIRTUAL_MOUNTS = ['/proc', '/sys', '/dev', '/run', '/snap']

/**
 * Exact mount points to hide even though they carry a real filesystem: OS
 * partitions the user can't grow, and `/home` when it is a btrfs subvolume of an
 * already-listed data volume (a duplicate of `/volume1` here, not a second disk).
 */
const SKIP_MOUNTS = new Set(['/boot', '/rootfs', '/ugreen', '/mnt/factory', '/overlay', '/home'])

/** How many filesystems the panel shows. */
const DISK_ROWS = 8
/** Disk capacity changes slowly; rescan it at most this often (ms). */
const DISK_TTL_MS = 5000
/** Linux reports `/proc/stat` in USER_HZ ticks, which is 100 on every real target. */
const USER_HZ = 100

function num(value: string | undefined, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function ratio(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0
  return Math.min(1, Math.max(0, part / whole))
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

const execFileAsync = promisify(execFile)

/** Run a short command, returning trimmed stdout or `null` on any failure. */
async function run(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 2000,
      maxBuffer: 1 << 20,
      windowsHide: true,
    })
    return String(stdout).trim()
  } catch {
    return null
  }
}

/** Parse `/proc/stat`: the `cpu` aggregate line and every `cpuN` line. */
function parseProcStat(text: string): ProcStat {
  let cpu: CpuTimes | null = null
  const cores: CpuTimes[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu')) continue
    const fields = line.trim().split(/\s+/)
    const label = fields[0] ?? ''
    // user nice system idle iowait irq softirq steal | guest guest_nice
    const tick: CpuTimes = {
      idle: num(fields[4]) + num(fields[5]),
      total:
        num(fields[1]) + num(fields[2]) + num(fields[3]) + num(fields[4]) +
        num(fields[5]) + num(fields[6]) + num(fields[7]) + num(fields[8]),
    }
    if (label === 'cpu') cpu = tick
    else cores.push(tick)
  }
  return { cpu, cores }
}

/** Utilisation between two ticks; `null` when the pair carries no time. */
function deltaRatio(current: CpuTimes, earlier: CpuTimes | undefined): number | null {
  if (earlier === undefined) return null
  const total = current.total - earlier.total
  if (total <= 0) return null
  return ratio(total - (current.idle - earlier.idle), total)
}

interface Meminfo {
  readonly total: number
  readonly free: number
  readonly available: number
  readonly cached?: number
  readonly buffers?: number
  readonly swap: SwapInfo | null
}

/** Parse `/proc/meminfo`; values are kB. */
function parseMeminfo(text: string): Meminfo | null {
  const values = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)/.exec(line)
    if (match !== null) values.set(match[1] as string, num(match[2]) * 1024)
  }
  const total = values.get('MemTotal')
  if (total === undefined || total <= 0) return null
  const free = values.get('MemFree') ?? 0
  const cached = values.get('Cached')
  const buffers = values.get('Buffers')
  const swapTotal = values.get('SwapTotal') ?? 0
  const swapFree = values.get('SwapFree') ?? 0
  return {
    total,
    free,
    // MemAvailable is the kernel's own estimate; derive it only for old kernels.
    available: values.get('MemAvailable') ?? free + (cached ?? 0) + (buffers ?? 0),
    ...(cached === undefined ? {} : { cached }),
    ...(buffers === undefined ? {} : { buffers }),
    swap:
      swapTotal <= 0
        ? null
        : { total: swapTotal, used: swapTotal - swapFree, ratio: ratio(swapTotal - swapFree, swapTotal) },
  }
}

/** Read load averages, preferring `/proc/loadavg`, which never lags `os.loadavg()`'s 5 s cache. */
async function readLoad(): Promise<[number, number, number]> {
  const text = await readText('/proc/loadavg')
  if (text !== null) {
    const fields = text.trim().split(/\s+/)
    return [num(fields[0]), num(fields[1]), num(fields[2])]
  }
  const [one = 0, five = 0, fifteen = 0] = os.loadavg()
  return [one, five, fifteen]
}

interface MountCandidate {
  readonly mount: string
  readonly device: string
  readonly fsType: string
}

/** `/proc/mounts` escapes spaces and friends as octal. */
function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )
}

function isInterestingMount(mount: string, fsType: string): boolean {
  if (VIRTUAL_FS.has(fsType)) return false
  if (SKIP_MOUNTS.has(mount)) return false
  return !VIRTUAL_MOUNTS.some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`))
}

async function mountCandidates(): Promise<MountCandidate[]> {
  const text = await readText('/proc/mounts')
  if (text === null) return []
  const candidates: MountCandidate[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const fields = line.split(' ').filter((field) => field !== '')
    if (fields.length < 3) continue
    const mount = decodeMountField(fields[1] as string)
    const fsType = fields[2] as string
    if (seen.has(mount) || !isInterestingMount(mount, fsType)) continue
    seen.add(mount)
    candidates.push({ mount, device: decodeMountField(fields[0] as string), fsType })
  }
  return candidates
}

/** One `statfs` call, tolerating a mount that vanished between scan and read. */
function capacity(mount: string): { total: number; used: number; available: number } | null {
  try {
    const stats = statfsSync(mount)
    const total = stats.blocks * stats.bsize
    if (total <= 0) return null
    const free = stats.bfree * stats.bsize
    return { total, used: total - free, available: stats.bavail * stats.bsize }
  } catch {
    return null
  }
}

/** Order filesystems for the panel: root first, then most full first. */
function tidyDisks(rows: DiskInfo[]): DiskInfo[] {
  const unique: DiskInfo[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.mount)) continue
    seen.add(row.mount)
    unique.push(row)
  }
  unique.sort((a, b) => {
    if (a.mount === '/') return -1
    if (b.mount === '/') return 1
    return b.ratio - a.ratio
  })
  return unique.slice(0, DISK_ROWS)
}

function disksFromMounts(candidates: MountCandidate[]): DiskInfo[] {
  const rows: DiskInfo[] = []
  for (const candidate of candidates) {
    const size = capacity(candidate.mount)
    if (size === null) continue
    rows.push({
      mount: candidate.mount,
      device: candidate.device,
      ...(candidate.fsType === '' ? {} : { fsType: candidate.fsType }),
      ...size,
      ratio: ratio(size.used, size.total),
    })
  }
  return tidyDisks(rows)
}

/** POSIX `df -Pk` fallback for platforms without `/proc/mounts`. */
function disksFromDf(): Promise<DiskInfo[]> {
  return new Promise((resolve) => {
    execFile('df', ['-Pk'], { timeout: 2000, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        resolve([])
        return
      }
      const rows: DiskInfo[] = []
      for (const line of stdout.split('\n').slice(1)) {
        // device blocks used available capacity mount-point
        const fields = line.trim().split(/\s+/)
        if (fields.length < 6) continue
        const mount = fields.slice(5).join(' ')
        const total = num(fields[1]) * 1024
        if (total <= 0) continue
        rows.push({
          mount,
          device: fields[0] as string,
          total,
          used: num(fields[2]) * 1024,
          available: num(fields[3]) * 1024,
          ratio: ratio(num(fields[2]), num(fields[1])),
        })
      }
      resolve(tidyDisks(rows))
    })
  })
}

/* ------------------------------------------------------------------ */
/* macOS (Darwin) sampling — sysctl / vm_stat / BSD df, all text-based  */
/* ------------------------------------------------------------------ */

/**
 * Aggregate CPU ticks from `sysctl kern.cp_time`: user nice system idle intr,
 * in 100 Hz ticks (USER_HZ == 100 on Darwin too). Returns `null` when the
 * machine does not expose them.
 */
async function readMacCpuTimes(): Promise<CpuTimes | null> {
  const text = await run('sysctl', ['-n', 'kern.cp_time'])
  if (text === null) return null
  const fields = text.trim().split(/\s+/).map((field) => num(field))
  // user nice system idle intr
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0)
  const total = (fields[0] ?? 0) + (fields[1] ?? 0) + (fields[2] ?? 0) + idle
  if (total <= 0) return null
  return { idle, total }
}

/** Swap from `sysctl vm.swapusage`: `total = X  used = Y  free = Z  ...`. */
async function readMacSwap(): Promise<SwapInfo | null> {
  const text = await run('sysctl', ['-n', 'vm.swapusage'])
  if (text === null) return null
  const grab = (key: string): number | null => {
    const match = new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGTP]?)`, 'i').exec(text)
    if (match === null) return null
    const units = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }
    const power = units[(match[2] ?? '').toUpperCase() as keyof typeof units] ?? 1
    return num(match[1]) * power
  }
  const total = grab('total')
  const used = grab('used')
  if (total === null || total <= 0 || used === null) return null
  return { total, used, ratio: ratio(used, total) }
}

/**
 * Available memory from `vm_stat` as `free + inactive + speculative` pages,
 * which is how macOS itself reports "memory available to new apps". Falls back
 * to `os.freemem()` (free only, under-reports) when `vm_stat` is unavailable.
 */
async function readMacAvailable(): Promise<number> {
  const pageSize = num((await run('sysctl', ['-n', 'hw.pagesize'])) ?? undefined, 16384)
  const text = await run('vm_stat', [])
  if (text === null) return os.freemem()
  const pages = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^"?(?:Pages\s+)?([\w\s-]+?)"?:\s+([\d.]+)\.?$/.exec(line.trim())
    if (match === null) continue
    pages.set(match[1] as string, num(match[2]))
  }
  const free = pages.get('free') ?? 0
  const inactive = pages.get('inactive') ?? 0
  const speculative = pages.get('speculative') ?? 0
  // Compressed/swap-backed pages count toward "used", so don't add them here.
  return (free + inactive + speculative) * pageSize
}

/**
 * macOS filesystems from BSD `df -k` (1 KB blocks, no GNU `-P`). APFS makes a
 * single volume look like many `.../System/Volumes/...` mounts, so collapse by
 * device and drop the internal/read-only ones the user can't fill.
 */
async function disksFromMacDf(): Promise<DiskInfo[]> {
  const text = await run('df', ['-k'])
  if (text === null) return []
  const rows: DiskInfo[] = []
  const seenDevices = new Set<string>()
  for (const line of text.split('\n').slice(1)) {
    // device blocks used available capacity mount
    const fields = line.trim().split(/\s+/)
    if (fields.length < 6) continue
    const mount = fields.slice(5).join(' ')
    if (!mount.startsWith('/')) continue
    const total = num(fields[1]) * 1024
    if (total <= 0) continue
    const device = fields[0] as string
    // APFS: `/` and `/System/Volumes/Data` are one pool — keep the most full one
    // and drop the read-only snapshot mount.
    if (seenDevices.has(device)) continue
    seenDevices.add(device)
    rows.push({
      mount,
      device,
      total,
      used: num(fields[2]) * 1024,
      available: num(fields[3]) * 1024,
      ratio: ratio(num(fields[2]), num(fields[1])),
    })
  }
  return tidyDisks(rows)
}

let previous: ProcStat | null = null
let previousMacCpu: CpuTimes | null = null
let seq = 0
let mounts: MountCandidate[] | null = null
let diskAt = 0
let diskRows: DiskInfo[] = []

/**
 * Collect one snapshot.
 * @param now - sample time in epoch milliseconds.
 * @returns the completed snapshot; never throws.
 */
export async function sample(now = Date.now()): Promise<SystemStatsSnapshot> {
  const platform = process.platform
  const linux = platform === 'linux'
  const darwin = platform === 'darwin'
  const [statText, memText, load] = await Promise.all([
    linux ? readText('/proc/stat') : Promise.resolve(null),
    linux ? readText('/proc/meminfo') : Promise.resolve(null),
    readLoad(),
  ])

  const count = os.cpus()
  let cpuUsage: number | null = null
  let cpuCores: number[] = []
  let cpuBusyMs: number | null = null

  if (linux) {
    if (statText !== null) {
      const tick = parseProcStat(statText)
      const earlier = previous
      const aggregate = tick.cpu
      cpuUsage = aggregate === null ? null : deltaRatio(aggregate, earlier?.cpu ?? undefined)
      cpuCores = tick.cores.map((core, index) => deltaRatio(core, earlier?.cores[index]) ?? 0)
      if (aggregate !== null) {
        cpuBusyMs = Math.round(((aggregate.total - aggregate.idle) / USER_HZ) * 1000)
      }
      previous = tick
    }
  } else if (darwin) {
    // Darwin ticks come from `sysctl kern.cp_time`; same delta math as `/proc/stat`.
    const tick = await readMacCpuTimes()
    const earlier = previousMacCpu
    cpuUsage = deltaRatio(tick ?? { idle: 0, total: 0 }, earlier ?? undefined)
    if (tick !== null && earlier !== undefined) {
      cpuBusyMs = Math.round(((tick.total - tick.idle) / USER_HZ) * 1000)
    }
    // `kern.cp_time` is aggregate only; per-core ticks need a native binding we
    // deliberately avoid, so the core grid stays empty on macOS.
    cpuCores = []
    previousMacCpu = tick
  } else {
    // No tick counters on this platform: a load-normalized estimate is all there is.
    cpuUsage = ratio(load[0], Math.max(1, count.length))
  }

  let meminfo: Meminfo | null = null
  if (memText !== null) meminfo = parseMeminfo(memText)

  const memTotal = meminfo?.total ?? os.totalmem()
  const memAvailable = darwin ? await readMacAvailable() : meminfo?.available ?? os.freemem()
  const memory: MemoryInfo = {
    total: memTotal,
    used: Math.max(0, memTotal - memAvailable),
    free: meminfo?.free ?? os.freemem(),
    available: memAvailable,
    ...(meminfo?.cached === undefined ? {} : { cached: meminfo.cached }),
    ...(meminfo?.buffers === undefined ? {} : { buffers: meminfo.buffers }),
    ratio: ratio(memTotal - memAvailable, memTotal),
  }

  if (now - diskAt > DISK_TTL_MS) {
    diskAt = now
    if (linux) {
      mounts ??= await mountCandidates()
      diskRows = mounts.length > 0 ? disksFromMounts(mounts) : await disksFromDf()
    } else if (darwin) {
      diskRows = await disksFromMacDf()
    } else {
      diskRows = await disksFromDf()
    }
  }

  const rss = process.memoryUsage()
  seq += 1

  return {
    sampledAt: now,
    seq,
    hostname: os.hostname(),
    platform,
    arch: process.arch,
    release: os.release(),
    uptime: os.uptime(),
    cpuCount: count.length,
    cpuModel: (count[0]?.model ?? 'unknown').trim(),
    cpuUsage,
    cpuCores,
    cpuBusyMs,
    load,
    memory,
    swap: darwin ? await readMacSwap() : meminfo?.swap ?? null,
    disks: diskRows,
    proc: { rss: rss.rss, heapUsed: rss.heapUsed },
  }
}

/** Drop cached state so a reload starts from a clean tick. */
export function resetSampler(): void {
  previous = null
  previousMacCpu = null
  seq = 0
  mounts = null
  diskAt = 0
  diskRows = []
}
