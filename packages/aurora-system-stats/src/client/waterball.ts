/**
 * The orb itself: a glass ball filled with water to the current CPU level.
 *
 * The fill is a real water line, not a ring: an SVG wave whose vertical position
 * is the level, drawn inside a circular clip with two offset crests drifting at
 * different speeds so the surface never looks static.
 *
 * Deliberately there is no CSS border, no inset shadow and no wrapping frame on
 * either the button or this element: the shell's own `button` rules and a second
 * concentric edge are exactly what turns a ball into "a circle inside another
 * circle". The single edge is the SVG circle the water clips to, so the rim and
 * the water can never disagree by a pixel.
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
 * A circular glass ball with a water level.
 *
 * The level is clamped to 3–97% so the surface stays readable at both extremes.
 * @returns the ball element; it is exactly `size` square with no border of its own.
 */
export function WaterBall({ ratio, tone, size, live = true, children }: WaterBallProps): ReactNode {
  const level = Math.min(0.97, Math.max(0.03, Number.isFinite(ratio) ? ratio : 0))
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
        // The glass body is a faint tint of the page's own surface, so the ball sits
        // on any background without needing an outline to separate it.
        h(
          'radialGradient',
          { id: `aurora-glass-${id}`, cx: '0.32', cy: '0.22', r: '0.9' },
          h('stop', { key: 'a', offset: '0%', stopColor: 'var(--aurora-surface)' }),
          h('stop', { key: 'b', offset: '78%', stopColor: 'color-mix(in srgb, var(--aurora-surface) 88%, var(--aurora-brand))' }),
          h('stop', { key: 'c', offset: '100%', stopColor: 'color-mix(in srgb, var(--aurora-surface) 78%, var(--aurora-brand))' }),
        ),
        // The one shadow, shaped like the ball instead of like a box: a soft pass for
        // lift plus a tight pass that hugs the rim.
        h(
          'filter',
          { id: `aurora-drop-${id}`, x: '-25%', y: '-25%', width: '150%', height: '150%', colorInterpolationFilters: 'sRGB' },
          h('feDropShadow', { dx: '0', dy: '3', stdDeviation: '3', floodColor: '#0f172a', floodOpacity: '0.16' }),
          h('feDropShadow', { dx: '0', dy: '1', stdDeviation: '0.7', floodColor: '#0f172a', floodOpacity: '0.16' }),
        ),
      ),
      // Everything painted is one circle: body, clip, shadow.
      h(
        'g',
        { filter: `url(#aurora-drop-${id})`, className: 'aurora-ball-body' },
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
        // The rim: the same circle the water clips to, so there is exactly one edge.
        h('circle', {
          cx: radius,
          cy: radius,
          r: radius - 0.5,
          fill: 'none',
          stroke: 'var(--aurora-glass-edge)',
          strokeWidth: 1,
          className: 'aurora-ball-rim',
        }),
      ),
    ),
    h('span', { className: 'aurora-ball-shine', 'aria-hidden': true }),
    children === undefined ? null : h('div', { className: 'aurora-ball-content' }, children),
  )
}
