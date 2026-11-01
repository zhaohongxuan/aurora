/**
 * Host half of aurora-system-stats.
 *
 * The browser half polls one exact Fetch route on the shared `/api` channel;
 * this module answers it from the sampler and stays otherwise inert. The route
 * belongs to the authenticated connection channel, so it inherits the Host and
 * Origin fence plus the browser credential check instead of opening a port.
 * @module aurora-system-stats
 */

import type { Disposer, Logger, PluginContext } from '../cordis.js'
import { sample, type SystemStatsSnapshot } from './sampler.js'

export type {
  DiskInfo,
  MemoryInfo,
  NetworkInfo,
  SwapInfo,
  SystemStatsSnapshot,
} from '../types.js'

/** Stable Cordis plugin name; the Loader row and diagnostics use it. */
export const name = 'aurora-system-stats'

/** The Host services this plugin cannot work without. */
export const inject = ['connection']

/** Absolute path of the stats route on the shared `/api` channel. */
export const STATS_ROUTE = '/api/aurora/system-stats'

/** Minimum spacing between two samples, so a polling storm cannot thrash `/proc`. */
const MIN_INTERVAL_MS = 250

/** One exact Fetch route as the connection service registers it. */
interface FetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

/** The slice of `ctx.connection` this plugin relies on. */
interface HostConnection {
  readonly fetch?: {
    readonly register?: (route: FetchRoute) => Disposer | Promise<Disposer>
  }
}

/** JSON for one snapshot, never cacheable. */
function encode(snapshot: SystemStatsSnapshot): Response {
  return Response.json(
    { ok: true, value: snapshot },
    // Heap and load figures are worthless from a cache.
    { headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * Build the route handler. Overlapping polls within {@link MIN_INTERVAL_MS} share
 * one sample, so a click storm or a second tab cannot multiply `/proc` reads.
 * @param logger - host logger for failure diagnostics.
 * @returns the Fetch-shaped handler.
 */
function createResponder(logger: Logger): () => Promise<Response> {
  let lastAt = 0
  let pending: Promise<Response> | null = null

  const failure = (error: unknown): Response => {
    logger.warn(`aurora-system-stats: sampling failed: ${String(error)}`)
    return Response.json(
      { ok: false, error: { code: 'aurora/stats-failed', message: String(error) } },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }

  return async () => {
    const now = Date.now()
    if (pending !== null && now - lastAt < MIN_INTERVAL_MS) return await pending
    lastAt = now
    const running = sample(now).then(encode, failure)
    pending = running
    try {
      return await running
    } finally {
      if (pending === running) pending = null
    }
  }
}

/**
 * Register the stats route for the browser half.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: PluginContext): void {
  const logger = ctx.logger(name)
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get<HostConnection>('connection')
    const registry = connection?.fetch
    const register = registry?.register
    if (registry === undefined || typeof register !== 'function') {
      logger.warn(
        'the host connection exposes no fetch registry; the floating orb will render without data',
      )
      return
    }
    const serve = createResponder(logger)
    ctx.effect(
      () =>
        register.call(registry, {
          path: STATS_ROUTE,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: serve,
        }),
      'aurora-system-stats: stats route',
    )
  })
}
