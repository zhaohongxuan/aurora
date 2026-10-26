/**
 * The ring and sparkline primitives the orb and its panel are built from.
 *
 * Both are plain SVG driven by CSS custom properties, so they follow the DSH
 * light and dark themes (`--dsw-*` tokens resolved in styles.css) without the
 * component knowing which theme is active.
 * @module aurora-system-stats/client/charts
 */

import { createElement as h, type ReactNode } from 'react'

/** Gradient stop colors for the three pressure tones. */
const TONES = {
  ok: ['var(--aurora-ok-from)', 'var(--aurora-ok-to)'],
  warn: ['var(--aurora-warn-from)', 'var(--aurora-warn-to)'],
  crit: ['var(--aurora-crit-from)', 'var(--aurora-crit-to)'],
} as const

export type RingTone = keyof typeof TONES

/** Per-instance gradient ids stay unique across several mounted orbs. */
let instance = 0

export interface RingProps {
  /** Filled share, 0–1. */
  readonly ratio: number
  readonly tone: RingTone
  /** Outer diameter in px. */
  readonly size: number
  /** Stroke width in px. */
  readonly stroke: number
  /** Content drawn inside the ring. */
  readonly children?: ReactNode
  /** Extra class applied to the wrapper. */
  readonly className?: string
}

/**
 * A circular gauge: a track ring with a gradient arc starting at twelve o'clock.
 * The arc keeps a 2% stub when empty so the ring never collapses to a dot.
 */
export function Ring({ ratio, tone, size, stroke, children, className }: RingProps): ReactNode {
  const id = `aurora-ring-${(instance += 1)}`
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.max(clamped, 0.02))
  const [from, to] = TONES[tone]
  return h(
    'div',
    { className: ['aurora-ring', className].filter(Boolean).join(' '), style: { width: size, height: size } },
    h(
      'svg',
      { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true },
      h(
        'defs',
        null,
        h('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' }, [
          h('stop', { key: 'a', offset: '0%', stopColor: from }),
          h('stop', { key: 'b', offset: '100%', stopColor: to }),
        ]),
      ),
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: 'var(--aurora-track)',
        strokeWidth: stroke,
      }),
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: `url(#${id})`,
        strokeWidth: stroke,
        strokeLinecap: 'round',
        strokeDasharray: circumference,
        strokeDashoffset: offset,
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
        className: 'aurora-ring-arc',
      }),
    ),
    children === undefined ? null : h('div', { className: 'aurora-ring-content' }, children),
  )
}

export interface SparklineProps {
  /** Oldest first; values are 0–1. */
  readonly points: readonly number[]
  readonly tone: RingTone
  /** Width in px. */
  readonly width: number
  /** Height in px. */
  readonly height: number
  /** Extra class applied to the svg. */
  readonly className?: string
}

/**
 * A filled area sparkline for the last N samples. A flat or empty series still
 * draws a baseline so the row keeps its height instead of collapsing.
 */
export function Sparkline({ points, tone, width, height, className }: SparklineProps): ReactNode {
  const id = `aurora-spark-${(instance += 1)}`
  const [from, to] = TONES[tone]
  const pad = 1
  const innerW = Math.max(1, width - pad * 2)
  const innerH = Math.max(1, height - pad * 2)
  const list = points.length > 0 ? points : [0]
  const step = list.length > 1 ? innerW / (list.length - 1) : innerW
  const coords = list.map((value, index) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
    return [pad + index * step, pad + innerH - clamped * innerH] as const
  })
  const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${line} L${(pad + innerW).toFixed(2)},${(pad + innerH).toFixed(2)} L${pad},${(pad + innerH).toFixed(2)} Z`
  return h(
    'svg',
    {
      className: ['aurora-spark', className].filter(Boolean).join(' '),
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      'aria-hidden': true,
    },
    h(
      'defs',
      null,
      h('linearGradient', { id, x1: '0', y1: '0', x2: '0', y2: '1' }, [
        h('stop', { key: 'a', offset: '0%', stopColor: from, stopOpacity: 0.55 }),
        h('stop', { key: 'b', offset: '100%', stopColor: to, stopOpacity: 0 }),
      ]),
    ),
    h('path', { d: area, fill: `url(#${id})`, stroke: 'none' }),
    h('path', {
      d: line,
      fill: 'none',
      stroke: to,
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      vectorEffect: 'non-scaling-stroke',
    }),
  )
}
