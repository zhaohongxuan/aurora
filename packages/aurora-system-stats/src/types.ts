/**
 * The wire contract shared by both halves.
 *
 * The host serializes {@link SystemStatsSnapshot}; the browser half only needs
 * the shape, so this module stays free of runtime imports and can be compiled
 * into either side.
 * @module aurora-system-stats/src/types
 */

/** One labeled filesystem row. */
export interface DiskInfo {
  readonly mount: string
  readonly device: string
  readonly fsType?: string
  readonly total: number
  readonly used: number
  readonly available: number
  /** Used share of capacity, 0–1. */
  readonly ratio: number
}

/** Memory figures in bytes. */
export interface MemoryInfo {
  readonly total: number
  readonly used: number
  readonly free: number
  readonly available: number
  readonly cached?: number
  readonly buffers?: number
  /** Used share of total, 0–1. */
  readonly ratio: number
}

/** Swap figures in bytes; `null` when none is configured. */
export interface SwapInfo {
  readonly total: number
  readonly used: number
  readonly ratio: number
}

/**
 * Network throughput. Counters are cumulative bytes since boot; the rates are
 * bytes per second derived from the host's previous sample, so a fresh sampler
 * reports `0` rates until it has two ticks to diff.
 */
export interface NetworkInfo {
  /** Cumulative bytes received across physical interfaces. */
  readonly rxBytes: number
  /** Cumulative bytes sent across physical interfaces. */
  readonly txBytes: number
  /** Receive rate in bytes per second over the last sampling interval. */
  readonly rxRate: number
  /** Transmit rate in bytes per second over the last sampling interval. */
  readonly txRate: number
}

/** One complete host sample. */
export interface SystemStatsSnapshot {
  readonly sampledAt: number
  readonly seq: number
  readonly hostname: string
  readonly platform: string
  readonly arch: string
  readonly release: string
  readonly uptime: number
  readonly cpuCount: number
  readonly cpuModel: string
  /** `null` only on the very first sample of a host tick series. */
  readonly cpuUsage: number | null
  readonly cpuCores: readonly number[]
  readonly cpuBusyMs: number | null
  readonly load: readonly [number, number, number]
  readonly memory: MemoryInfo
  readonly swap: SwapInfo | null
  readonly disks: readonly DiskInfo[]
  readonly network: NetworkInfo | null
  readonly proc: {
    readonly rss: number
    readonly heapUsed: number
  }
}

/** The envelope every host route answers with. */
export type StatsResponse =
  | { readonly ok: true; readonly value: SystemStatsSnapshot }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
