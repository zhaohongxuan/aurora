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
])

/** Mount-point prefixes that never belong in a "how full is my machine" list. */
const VIRTUAL_MOUNTS = ['/proc', '/sys', '/dev', '/run', '/snap']

/** How many filesystems the panel shows. */
const DISK_ROWS = 4
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

let previous: ProcStat | null = null
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
  const linux = process.platform === 'linux'
  const [statText, memText, load] = await Promise.all([
    linux ? readText('/proc/stat') : Promise.resolve(null),
    linux ? readText('/proc/meminfo') : Promise.resolve(null),
    readLoad(),
  ])

  const count = os.cpus()
  let cpuUsage: number | null = null
  let cpuCores: number[] = []
  let cpuBusyMs: number | null = null

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
  } else {
    // No tick counters on this platform: a load-normalized estimate is all there is.
    cpuUsage = ratio(load[0], Math.max(1, count.length))
  }

  const meminfo = memText === null ? null : parseMeminfo(memText)
  const memTotal = meminfo?.total ?? os.totalmem()
  const memAvailable = meminfo?.available ?? os.freemem()
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
    mounts ??= linux ? await mountCandidates() : []
    diskRows = mounts.length > 0 ? disksFromMounts(mounts) : await disksFromDf()
  }

  const rss = process.memoryUsage()
  seq += 1

  return {
    sampledAt: now,
    seq,
    hostname: os.hostname(),
    platform: process.platform,
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
    swap: meminfo?.swap ?? null,
    disks: diskRows,
    proc: { rss: rss.rss, heapUsed: rss.heapUsed },
  }
}

/** Drop cached state so a reload starts from a clean tick. */
export function resetSampler(): void {
  previous = null
  seq = 0
  mounts = null
  diskAt = 0
  diskRows = []
}
