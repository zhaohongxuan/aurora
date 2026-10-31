/**
 * Formatting helpers for the orb and its panel.
 *
 * Everything here is locale-neutral and dependency-free: numbers keep two
 * significant decimals at most, and percentages always show whole integers so
 * a 12 px label never jitters.
 * @module aurora-system-stats/client/format
 */

/** Format a 0–1 ratio as a whole percentage, e.g. `0.3721` → `37%`. */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`
}

/** Format a 0–1 ratio as one decimal percentage, e.g. `0.3721` → `37.2%`. */
export function pct1(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(1)}%`
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Format a byte count with binary units, e.g. `3_650_508_800` → `3.4 GB`. */
export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '–'
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024
    unit += 1
  }
  const digits = scaled >= 100 || unit === 0 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(digits)} ${UNITS[unit]}`
}

/** Split a byte count into its number and unit, for two-line tiles. */
export function byteParts(value: number | null | undefined): { value: string; unit: string } {
  const formatted = bytes(value)
  const space = formatted.lastIndexOf(' ')
  if (space < 0) return { value: formatted, unit: '' }
  return { value: formatted.slice(0, space), unit: formatted.slice(space + 1) }
}

/** Format a load average with two decimals, e.g. `0.92`. */
export function loadValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  return value >= 100 ? value.toFixed(0) : value.toFixed(2)
}

/** Format an uptime in seconds as `12d 4h`, `4h 07m` or `7m`. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m`
  return `${total}s`
}

type Tone = 'ok' | 'warn' | 'crit'

/** Classify a 0–1 ratio for coloring; thresholds match the ring gradients. */
export function tone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'ok'
  if (value >= 0.9) return 'crit'
  if (value >= 0.7) return 'warn'
  return 'ok'
}

/** Classify a load average against the processor count. */
export function loadTone(load: number, cpuCount: number): Tone {
  if (!Number.isFinite(load) || cpuCount <= 0) return 'ok'
  const normalized = load / cpuCount
  if (normalized >= 1.5) return 'crit'
  if (normalized >= 1) return 'warn'
  return 'ok'
}

/** The value used on the collapsed orb: CPU when readable, otherwise memory pressure. */
export function orbValue(
  cpu: number | null | undefined,
  memory: number,
): { ratio: number; label: string; tone: Tone } {
  const ratio = cpu ?? memory
  return { ratio, label: pct(ratio), tone: tone(ratio) }
}
