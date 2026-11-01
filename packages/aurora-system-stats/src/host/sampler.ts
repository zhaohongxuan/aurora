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
  NetworkInfo,
  ProcessInfo,
  SwapInfo,
  SystemStatsSnapshot,
} from '../types.js'

export type { DiskInfo, MemoryInfo, NetworkInfo, ProcessInfo, SwapInfo, SystemStatsSnapshot }

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
 * Per-core CPU ticks from `node:os`. On Apple Silicon `kern.cp_time` does not
 * exist (`sysctl: unknown oid`), so the only portable source is `os.cpus()`,
 * whose `times` are cumulative milliseconds per core. We fold them into the
 * same idle/total shape `/proc/stat` yields so the delta math is shared.
 */
function readMacCpuTicks(): { cpu: CpuTimes; cores: CpuTimes[] } {
  const cores: CpuTimes[] = []
  let idle = 0
  let total = 0
  for (const processor of os.cpus()) {
    const t = processor.times
    const coreIdle = t.idle
    const coreTotal = t.user + t.nice + t.sys + t.idle + t.irq
    cores.push({ idle: coreIdle, total: coreTotal })
    idle += coreIdle
    total += coreTotal
  }
  return { cpu: { idle, total }, cores }
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
 * macOS mount points that are internal APFS plumbing, read-only snapshots, or
 * app-injected overlays users never think of as "my disk". Keep it narrow:
 * the root/data pool and real `/Volumes/*` external disks should survive.
 */
function isNoiseMacMount(mount: string, device: string): boolean {
  // Pseudo-filesystems (devfs, map auto_home, network/VM shares).
  if (/^(devfs|map |OrbStack:|smbfs|afpfs|nfs|autofs)/.test(device)) return true
  // APFS internal volumes that back the OS, not user data.
  const noisyPrefixes = [
    '/System/Volumes/VM',
    '/System/Volumes/Preboot',
    '/System/Volumes/Update',
    '/System/Volumes/xarts',
    '/System/Volumes/iSCPreboot',
    '/System/Volumes/Hardware',
    '/System/Volumes/Data/home',
    '/System/Volumes/Recovery',
    '/Volumes/Recovery',
  ]
  if (noisyPrefixes.some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`))) return true
  // App-injected mounts: simulator runtimes live under Developer/CoreSimulator;
  // `.app/Wrapper` are per-app overlay disks.
  if (mount.includes('/Developer/CoreSimulator/')) return true
  if (mount.includes('.app/Wrapper')) return true
  // Scratch dirs Apple parks per-app temporary disks under.
  if (mount.startsWith('/private/var/folders/')) return true
  return false
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
    // BSD `df -k` interleaves inode columns and may contain spaces in the mount
    // point, so the column count is not fixed. Anchoring on the ends is safest:
    //   device blocks used avail capacity [iused ifree %iused] mount
    // -> device = field 0, blocks/used/avail = 1/2/3, mount = last field(s).
    const trimmed = line.trim()
    if (trimmed === '') continue
    const fields = trimmed.split(/\s+/)
    if (fields.length < 5) continue
    // The mount point is the trailing field; a device can never start with '/'
    // but a mount always does, so walk back from the end if needed (spaces).
    const mount = fields[fields.length - 1] as string
    if (!mount.startsWith('/')) continue
    const blocks = num(fields[1])
    const total = blocks * 1024
    if (total <= 0) continue
    const used = num(fields[2])
    const available = num(fields[3])
    const device = fields[0] as string
    // Noise the user can't act on: pseudo-filesystems, APFS internal
    // sub-volumes, the read-only recovery snapshot, and app-injected mounts
    // (simulator runtimes, `.app/Wrapper` overlays, network/VM shares).
    if (isNoiseMacMount(mount, device)) continue
    // APFS: `/` and `/System/Volumes/Data` are one pool — keep the most full one
    // and drop the read-only snapshot mount.
    if (seenDevices.has(device)) continue
    seenDevices.add(device)
    rows.push({
      mount,
      device,
      total,
      used: used * 1024,
      available: available * 1024,
      ratio: ratio(used, blocks),
    })
  }
  // On macOS the root `/` mount is a read-only system snapshot (~a few % used),
  // while the user's actual data lives on `/System/Volumes/Data` of the same
  // pool. Showing both is confusing, so when the data volume is present, present
  // it under the familiar `/` label and drop the snapshot row.
  const dataIndex = rows.findIndex((row) => row.mount === '/System/Volumes/Data')
  if (dataIndex !== -1) {
    const data = rows[dataIndex] as DiskInfo
    // Drop both the snapshot `/` row and the raw data-volume row, then present
    // the data volume once under the familiar `/` label.
    const rest = rows.filter((row) => row.mount !== '/' && row.mount !== '/System/Volumes/Data')
    rest.unshift({ ...data, mount: '/' })
    return tidyDisks(rest)
  }
  return tidyDisks(rows)
}

/* ------------------------------------------------------------------ */
/* Network throughput — cumulative interface counters, diffed for rate  */
/* ------------------------------------------------------------------ */

/** Cumulative byte counters summed across the physical interfaces. */
interface NetCounters {
  readonly rx: number
  readonly tx: number
}

/**
 * Interfaces whose counters we sum. Restricting to physical NICs keeps tunnel
 * (`utun`/`tun`), bridge, loopback and AirDrop (`awdl`) traffic from being
 * counted twice — the encapsulated bytes already ride the physical interface.
 */
const PHYSICAL_NIC = /^(en\d|eth\d|wlan\d|wl\w+|wlan|enp\w+|eno\w+|ens\w+)$/

function isPhysicalNic(name: string): boolean {
  return PHYSICAL_NIC.test(name)
}

/**
 * Read `/proc/net/dev` (Linux): one line per interface,
 * `iface: rxBytes rxPackets ... txBytes txPackets ...` where rx bytes is field 1
 * after the colon and tx bytes is field 9.
 */
async function readLinuxNet(): Promise<NetCounters | null> {
  const text = await readText('/proc/net/dev')
  if (text === null) return null
  let rx = 0
  let tx = 0
  let found = false
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim()
    if (!isPhysicalNic(name)) continue
    const fields = line.slice(colon + 1).trim().split(/\s+/)
    if (fields.length < 9) continue
    rx += num(fields[0])
    tx += num(fields[8])
    found = true
  }
  return found ? { rx, tx } : { rx: 0, tx: 0 }
}

/**
 * Read `netstat -ibn` (macOS). Interface-level totals live on the `<Link#N>`
 * rows; the address rows repeat the same counters, so filter to Link rows and
 * physical NICs to avoid double counting. Fields: name(1) ... Ibytes(7) ... Obytes(10).
 */
async function readMacNet(): Promise<NetCounters | null> {
  const text = await run('netstat', ['-ibn'])
  if (text === null) return null
  let rx = 0
  let tx = 0
  let found = false
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    // Only the link-layer row carries the aggregate for the interface.
    if (!(fields[2] ?? '').startsWith('<Link#')) continue
    const name = fields[0] as string
    if (!isPhysicalNic(name)) continue
    rx += num(fields[6])
    tx += num(fields[9])
    found = true
  }
  return found ? { rx, tx } : null
}

/**
 * Turn cumulative counters into a {@link NetworkInfo} using the previous sample.
 * Counters reset on interface flap / reboot, so a decrease is treated as a fresh
 * baseline (`0` rate) instead of a huge negative spike.
 * @param now - current counters.
 * @param earlier - previous counters, or `null` on the first sample.
 * @param elapsedMs - milliseconds since the previous sample (`<= 0` = unknown).
 */
function networkInfo(now: NetCounters, earlier: NetCounters | null, elapsedMs: number): NetworkInfo {
  let rxRate = 0
  let txRate = 0
  if (earlier !== null && elapsedMs > 0) {
    const seconds = elapsedMs / 1000
    const drx = now.rx - earlier.rx
    const dtx = now.tx - earlier.tx
    if (drx >= 0) rxRate = drx / seconds
    if (dtx >= 0) txRate = dtx / seconds
  }
  return { rxBytes: now.rx, txBytes: now.tx, rxRate, txRate }
}

/** How the panel's memory leaderboard trims names and how many rows it keeps. */
const PROC_ROWS = 5
const PROC_NAME_MAX = 16
/** Roots that hold every user-relevant systemd service and container cgroup. */
const CGROUP_ROOTS = ['/sys/fs/cgroup/system.slice', '/sys/fs/cgroup/user.slice']

/** Read a single integer from a cgroup control file; `0` if absent/unreadable. */
async function readCounter(path: string): Promise<number> {
  const text = await readText(path)
  return text === null ? 0 : num(text.trim())
}

/**
 * Real resident memory of a cgroup: `anon` (anonymous pages — heap, stacks,
 * allocations, transcode buffers) plus `shmem` (shared memory). Deliberately
 * excludes `file` page cache, which a media server inflates by reading large
 * files yet the kernel reclaims under pressure. Returns `0` if unreadable.
 */
async function readAnonShmem(statPath: string): Promise<number> {
  const text = await readText(statPath)
  if (text === null) return 0
  let total = 0
  for (const line of text.split('\n')) {
    const match = /^(anon|shmem)\s+(\d+)/.exec(line)
    if (match !== null) total += num(match[2])
  }
  return total
}

/** Trim a label to the panel's width, keeping a trailing ellipsis. */
function shortLabel(name: string): string {
  return name.length > PROC_NAME_MAX ? `${name.slice(0, PROC_NAME_MAX - 1)}…` : name
}

/**
 * Resolve a `docker-<id>.scope` cgroup to a friendly container name.
 *
 * Reads the first PID in the group's `cgroup.procs` and derives a friendly name
 * from its command line. The entry executable is argv[0]; when that is only an
 * interpreter/runtime shim (`python`, `node`, `docker-init`…), the real workload
 * is the following argument (e.g. `python -m peach.server` → `peach`). Falls
 * back to `docker:<short id>` when the process is gone or its cmdline is empty.
 */
const INTERPRETERS = new Set([
  'python', 'python3', 'node', 'docker-init', 'sh', 'bash', 'java', 'env', 'tini',
])

/** Pick the workload token from an argv, skipping interpreter shims and flags. */
function workloadArg(argv: readonly string[]): string {
  const base = (token: string): string =>
    token.includes('/') ? token.slice(token.lastIndexOf('/') + 1) : token
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    // `-m module` / `-c cmd` from an interpreter: the module IS the workload.
    if (arg === '-m' || arg === '-c') {
      const next = argv[index + 1] ?? ''
      return base(next)
    }
    if (arg === '' || arg === '--' || arg.startsWith('-')) continue
    const name = base(arg)
    // Keep scanning past interpreter shims (`python`, `node`, `docker-init`…).
    if (INTERPRETERS.has(name)) continue
    return name
  }
  return base(argv[0] ?? '')
}

async function containerLabel(scopePath: string, id: string): Promise<string> {
  const pids = await readText(`${scopePath}/cgroup.procs`)
  const first = pids?.trim().split('\n')[0]?.trim()
  if (first !== undefined && first !== '') {
    const cmdline = await readText(`/proc/${first}/cmdline`)
    if (cmdline !== null) {
      const argv = cmdline.split('\0').filter((part) => part !== '')
      const picked = workloadArg(argv)
      // Drop a `.server` / `.py`-ish module suffix so `peach.server` reads `peach`.
      const clean = picked.replace(/\.[a-z]+$/i, '')
      if (clean !== '') return shortLabel(clean)
    }
  }
  return `docker:${id.slice(0, 8)}`
}

/** Turn a leaf cgroup directory name into a display label. */
async function cgroupLabel(name: string, path: string): Promise<string> {
  if (name.startsWith('docker-') && name.endsWith('.scope')) {
    const id = name.slice('docker-'.length, -'.scope'.length)
    return containerLabel(path, id)
  }
  // `magpie.service` → `magpie`, `session-c6.scope` → `session-c6`.
  return shortLabel(name.replace(/\.(service|scope)$/, ''))
}

interface CgroupMemory {
  readonly current: number
  readonly swap: number
}

/**
 * Aggregate real resident memory (`anon` + `shmem`, minus page cache) per systemd
 * cgroup unit (service, container, or session) and return the heaviest
 * {@link PROC_ROWS}.
 *
 * Only **leaf** cgroups are counted: a parent slice (`system.slice`,
 * `user@1000.service`, `app.slice`) reports its whole subtree, so including
 * parents would double-count every child. Grouping by unit — not by PID — is
 * what keeps `magpie` or `dsh` (multi-process services) from being split into
 * several misleading rows.
 * @param memTotal - total physical memory in bytes, for the ratio.
 */
async function readTopCgroups(memTotal: number): Promise<ProcessInfo[]> {
  const groups = new Map<string, CgroupMemory>()

  /** Walk one cgroup root, summing only leaf units. */
  async function walk(dir: string, label: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const children = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    const hasMemory = entries.some((entry) => entry.name === 'memory.current')
    // A cgroup that has child cgroups is a slice/aggregate — descend, don't count.
    const childCgroups: string[] = []
    for (const child of children) {
      try {
        await fs.access(`${dir}/${child}/memory.current`)
        childCgroups.push(child)
      } catch {
        // Not a cgroup directory (a plain attribute dir) — ignore.
      }
    }
    if (childCgroups.length > 0) {
      for (const child of childCgroups) await walk(`${dir}/${child}`, child)
      return
    }
    if (!hasMemory) return
    // Interactive login sessions (`session-cN.scope`) are transient SSH/TTY
    // scopes, not services — showing them misleads the "what eats my RAM" list.
    if (label.startsWith('session-')) return
    // Report *real* memory, not `memory.current`: the latter also counts page
    // cache (`file`), which a media server balloons by reading big video files
    // yet the kernel reclaims on demand. `anon` (heap/stack/allocations) plus
    // `shmem` is what the process actually holds.
    const live = await readAnonShmem(`${dir}/memory.stat`)
    const swap = await readCounter(`${dir}/memory.swap.current`)
    if (live <= 0 && swap <= 0) return
    const key = await cgroupLabel(label, dir)
    const bucket = groups.get(key) ?? { current: 0, swap: 0 }
    groups.set(key, { current: bucket.current + live, swap: bucket.swap + swap })
  }

  for (const root of CGROUP_ROOTS) {
    // The root itself is an aggregate; its direct children are top-level units.
    let top: string[] = []
    try {
      top = (await fs.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('cgroup.'))
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const child of top) await walk(`${root}/${child}`, child)
  }

  return [...groups.entries()]
    .map(([name, mem]) => ({ name, rss: mem.current, swap: mem.swap, ratio: ratio(mem.current, memTotal) }))
    // Rank by resident memory only — swap is disk-backed, not physical RAM, so
    // mixing it in would let a mostly-swapped idle service outrank a hot one.
    .sort((a, b) => b.rss - a.rss)
    .slice(0, PROC_ROWS)
}

/**
 * macOS fallback: per-process resident memory from `ps`.
 *
 * BSD `ps` lacks `--sort`, so ordering happens here. cgroup v2 does not exist on
 * Darwin, so this reports individual processes (no service grouping, no swap).
 * @param memTotal - total physical memory in bytes, for the ratio.
 */
async function readTopProcs(memTotal: number): Promise<ProcessInfo[]> {
  const text = await run('ps', ['-eo', 'pid=,rss=,comm='])
  if (text === null) return []
  const rows: ProcessInfo[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match === null) continue
    const rss = num(match[2]) * 1024
    if (rss <= 0) continue
    const raw = (match[3] ?? '').trim()
    const base = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
    rows.push({ name: shortLabel(base), rss, swap: 0, ratio: ratio(rss, memTotal) })
  }
  rows.sort((a, b) => b.rss - a.rss)
  return rows.slice(0, PROC_ROWS)
}


let previous: ProcStat | null = null
let previousMacCpu: { cpu: CpuTimes; cores: CpuTimes[] } | null = null
let previousNet: NetCounters | null = null
let netAt = 0
let seq = 0
let mounts: MountCandidate[] | null = null
let diskAt = 0
let diskRows: DiskInfo[] = []
let procRows: ProcessInfo[] = []

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
    // Darwin has no `kern.cp_time` on Apple Silicon, so ticks come from
    // `os.cpus()` (cumulative ms per core); same delta math as `/proc/stat`.
    const tick = readMacCpuTicks()
    const earlier = previousMacCpu
    const nowTicks = tick.cpu
    const busyMs = earlier === null ? 0 : nowTicks.total - earlier.cpu.total - (nowTicks.idle - earlier.cpu.idle)
    cpuUsage = deltaRatio(nowTicks, earlier?.cpu ?? undefined)
    if (earlier !== null) cpuBusyMs = Math.round(busyMs)
    cpuCores = tick.cores.map((core, index) => deltaRatio(core, earlier?.cores[index]) ?? 0)
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
    // Walking cgroups (or forking `ps`) is comparatively pricey, so it rides
    // the same slow cadence as the disk scan rather than the 1 s network tick.
    procRows = linux ? await readTopCgroups(memTotal) : darwin ? await readTopProcs(memTotal) : []
  }

  // Network counters are cheap to read every tick; the rate needs the previous
  // sample, which `networkInfo` handles (including counter resets).
  const netNow = linux ? await readLinuxNet() : darwin ? await readMacNet() : null
  let network: NetworkInfo | null = null
  if (netNow !== null) {
    network = networkInfo(netNow, previousNet, netAt === 0 ? 0 : now - netAt)
    previousNet = netNow
    netAt = now
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
    network,
    procs: procRows,
    proc: { rss: rss.rss, heapUsed: rss.heapUsed },
  }
}

/** Drop cached state so a reload starts from a clean tick. */
export function resetSampler(): void {
  previous = null
  previousMacCpu = null
  previousNet = null
  netAt = 0
  seq = 0
  mounts = null
  diskAt = 0
  diskRows = []
  procRows = []
}
