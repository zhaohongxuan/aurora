/**
 * The orb itself: a glass ball filled with water to the current CPU level.
 *
 * Shape rule: the silhouette is an SVG circle whose element carries fixed
 * width/height attributes, so the ball stays round no matter how the surrounding
 * CSS box is sized (a `border-radius` + `overflow: hidden` box was clipped into a
 * rounded rectangle when the box stopped being square). There is no `feDropShadow`,
 * no off-centre highlight and no separate rim: those decorations were what made a
 * round ball read as a lopsided egg.
 *
 * The water line is a real surface: an SVG wave whose vertical position is the
 * level, with two out-of-phase crests drifting at different speeds.
 * @module aurora-system-stats/client/waterball
 */

import { createElement as h, type ReactNode } from 'react'
import type { RingTone } from './charts.js'

/** Water palettes per pressure tone: [surface/crest, deep]. */
const WATER = {
  ok: ['#7fe0a6', '#16a35c'],
  warn: ['#fcc45f', '#b87a12'],
  crit: ['#fb9186', '#bb332d'],
} as const

/** Width of one wave period in the SVG's own units; the paths scroll by exactly this. */
const PERIOD = 120

/**
 * One crest, closed to the bottom of the period box so the shape can be filled.
 * @param phase - radians added to the wave, used to stagger the two layers.
 * @param bottom - baseline the shape closes against.
 * @returns an SVG path in a `PERIOD` wide, `PERIOD` tall box.
 */
function wavePath(phase: number, bottom: number): string {
  const points: string[] = []
  for (let x = 0; x <= PERIOD; x += 4) {
    const angle = (x / PERIOD) * Math.PI * 2 + phase
    // Two summed sines read as water rather than as a plain sine.
    const lift = Math.sin(angle) * 2.4 + Math.sin(angle * 2) * 1
    points.push(`${x === 0 ? 'M' : 'L'}${x.toFixed(1)},${(20 + lift).toFixed(2)}`)
  }
  return `${points.join(' ')} L${PERIOD},${bottom} L0,${bottom} Z`
}

export interface WaterBallProps {
  /** Water level, 0–1. */
  readonly ratio: number
  readonly tone: RingTone
  /** Diameter in px. */
  readonly size: number
  /** Whether the level behind the water is live; an offline ball stops moving. */
  readonly live?: boolean
  readonly children?: ReactNode
}

/**
 * A circular ball with a water level.
 *
 * The level is clamped to 20–97%: the floor keeps a visible base of water even
 * when the CPU is idle, and the ceiling keeps the surface readable at the top.
 * @returns the ball element; the visible circle is its CSS box, not a drawing.
 */
export function WaterBall({ ratio, tone, size, live = true, children }: WaterBallProps): ReactNode {
  const level = Math.min(0.97, Math.max(0.2, Number.isFinite(ratio) ? ratio : 0))
  const radius = size / 2
  const [crest, deep] = WATER[tone]
  const id = `w${size}`
  // The wave box is PERIOD tall; the surface sits `level` of the way down the ball.
  const surfaceY = size * (1 - level)
  const scale = size / PERIOD
  return h(
    'div',
    {
      className: ['aurora-ball', live ? '' : 'is-offline'].join(' ').trim(),
      style: { width: size, height: size },
      'data-tone': tone,
    },
    h(
      'svg',
      { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true, className: 'aurora-ball-svg' },
      h(
        'defs',
        null,
        h('clipPath', { id: `aurora-clip-${id}` }, h('circle', { cx: radius, cy: radius, r: radius })),
        h(
          'linearGradient',
          { id: `aurora-water-${id}`, x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { key: 'a', offset: '0%', stopColor: crest }),
          h('stop', { key: 'b', offset: '100%', stopColor: deep }),
        ),
        // Glass body: a *centred* radial gradient, so the shading is symmetric and
        // the ball stays perceptually round. No highlight offset, no rim.
        h(
          'radialGradient',
          { id: `aurora-glass-${id}`, cx: '0.5', cy: '0.5', r: '0.72' },
          h('stop', { key: 'a', offset: '0%', stopColor: 'var(--aurora-surface)' }),
          h('stop', { key: 'b', offset: '70%', stopColor: 'color-mix(in srgb, var(--aurora-surface) 90%, var(--aurora-brand))' }),
          h('stop', { key: 'c', offset: '100%', stopColor: 'color-mix(in srgb, var(--aurora-surface) 86%, var(--aurora-text))' }),
        ),
      ),
      // The glass disc: the one shape the whole ball reads from.
      h('circle', { cx: radius, cy: radius, r: radius, fill: `url(#aurora-glass-${id})` }),
      h(
        'g',
        { clipPath: `url(#aurora-clip-${id})` },
        h(
          'g',
          {
            className: 'aurora-ball-fill',
            transform: `translate(0 ${surfaceY.toFixed(2)}) scale(${scale.toFixed(4)})`,
          },
          [
            // The body: everything below the water line.
            h('path', { key: 'body', d: `M0,20 L0,${PERIOD} L${PERIOD},${PERIOD} L${PERIOD},20 Z`, fill: `url(#aurora-water-${id})` }),
            h('path', { key: 'back', className: 'aurora-ball-wave is-back', d: wavePath(Math.PI, PERIOD), fill: deep, opacity: 0.6 }),
            h('path', { key: 'front', className: 'aurora-ball-wave is-front', d: wavePath(0, PERIOD), fill: `url(#aurora-water-${id})` }),
          ],
        ),
      ),
    ),
    children === undefined ? null : h('div', { className: 'aurora-ball-content' }, children),
  )
}
