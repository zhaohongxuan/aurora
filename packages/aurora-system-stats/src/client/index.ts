/**
 * Browser half of aurora-system-stats.
 *
 * Docks one floating orb in the frame's `shell.overlay` seat, which draws over
 * all three columns of the DSH web GUI. The orb is built with `createElement`
 * rather than JSX, so this bundle needs only React from the shell's shared module
 * table — no primitives, no store, no dock kit.
 * @module aurora-system-stats/client
 */

import { createElement, type ReactNode } from 'react'
import { AuroraOrb } from './orb.js'
import { injectStyles } from './styles.js'

/** Stable Cordis plugin name. */
export const name = 'aurora-system-stats'

/** Client services this browser half cannot work without. */
export const inject = ['slots']

/** The slice of the root slot service this plugin uses. */
interface SlotsService {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject(seat: string, callback: () => unknown): unknown
}

/** Row config as it reaches the browser half. */
export interface ClientConfig {
  /** Poll spacing in milliseconds. */
  intervalMs?: number
}

function OrbSeat({ intervalMs }: { intervalMs: number }): ReactNode {
  return createElement(AuroraOrb, { intervalMs })
}

/**
 * Register the orb seat.
 *
 * This is the browser half's plugin body; {@link register} publishes it the way
 * the DSH loader reads a bundle (the factory hands back `module.exports`).
 * @param ctx - the browser plugin context (Cordis).
 * @param config - row config from the profile patch.
 */
export function register(ctx: { slots?: SlotsService }, config: ClientConfig = {}): void {
  const slots = ctx.slots
  if (slots === undefined || typeof slots.register !== 'function') return
  const intervalMs =
    typeof config.intervalMs === 'number' && Number.isFinite(config.intervalMs)
      ? Math.min(60_000, Math.max(500, config.intervalMs))
      : 2000

  injectStyles()

  slots.inject('shell.overlay', () =>
    slots.register(
      {
        name: 'shell.overlay',
        id: 'aurora-system-stats',
        order: 40,
      },
      () => createElement(OrbSeat, { intervalMs }),
    ),
  )
}

// The loader factory returns `module.exports`; a bundle registered that way must
// publish the plugin shape there, because a classic script cannot re-export ESM
// bindings of its own.
const shared = module.exports as Record<string, unknown>
shared.name = name
shared.inject = inject
shared.apply = register
