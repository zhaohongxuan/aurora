/**
 * The browser half's data source: one poller for the whole page.
 *
 * A single interval is shared by every mounted orb (there is normally exactly
 * one, but Slots may mount more during an HMR swap), polls stop while the tab is
 * hidden, and each poll is guarded against overlap. A failed poll keeps the last
 * good snapshot so the orb dims instead of vanishing.
 * @module aurora-system-stats/client/useStats
 */

import { useEffect, useRef, useState } from 'react'
import type { StatsResponse, SystemStatsSnapshot } from '../types.js'

/** Where the host mounts the stats route. */
export const STATS_ENDPOINT = '/api/aurora/system-stats'

/** How many samples each sparkline keeps. */
export const HISTORY = 60

export interface StatsState {
  /** The last successful snapshot, or `undefined` before the first answer. */
  readonly snapshot: SystemStatsSnapshot | undefined
  /** Whether the most recent poll succeeded. */
  readonly live: boolean
  /** Number of consecutive failures. */
  readonly failures: number
  /** CPU history, oldest first, 0–1. */
  readonly cpuHistory: readonly number[]
  /** Memory history, oldest first, 0–1. */
  readonly memHistory: readonly number[]
  /** Download rate history, oldest first, bytes per second. */
  readonly netDownHistory: readonly number[]
  /** Upload rate history, oldest first, bytes per second. */
  readonly netUpHistory: readonly number[]
}

const INITIAL: StatsState = {
  snapshot: undefined,
  live: true,
  failures: 0,
  cpuHistory: [],
  memHistory: [],
  netDownHistory: [],
  netUpHistory: [],
}

function push(history: readonly number[], value: number): number[] {
  const next = [...history, value]
  return next.length > HISTORY ? next.slice(next.length - HISTORY) : next
}

async function poll(signal: AbortSignal): Promise<SystemStatsSnapshot> {
  const response = await fetch(STATS_ENDPOINT, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`host answered ${response.status}`)
  const body = (await response.json()) as StatsResponse
  if (!body.ok) throw new Error(body.error.message)
  return body.value
}

/**
 * Subscribe to host samples.
 * @param intervalMs - poll spacing while the tab is visible.
 * @returns the current state; the poller stops on unmount.
 */
export function useSystemStats(intervalMs: number): StatsState {
  const [state, setState] = useState<StatsState>(INITIAL)
  const interval = useRef(intervalMs)
  interval.current = Math.max(500, intervalMs)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inflight: AbortController | undefined

    const schedule = () => {
      if (disposed) return
      timer = setTimeout(tick, interval.current)
    }

    const tick = () => {
      timer = undefined
      if (disposed) return
      if (document.visibilityState === 'hidden') {
        schedule()
        return
      }
      inflight?.abort()
      const controller = new AbortController()
      inflight = controller
      poll(controller.signal).then(
        (snapshot) => {
          if (disposed || controller !== inflight) return
          inflight = undefined
          setState((previous) => ({
            snapshot,
            live: true,
            failures: 0,
            cpuHistory: snapshot.cpuUsage === null ? previous.cpuHistory : push(previous.cpuHistory, snapshot.cpuUsage),
            memHistory: push(previous.memHistory, snapshot.memory.ratio),
            netDownHistory:
              snapshot.network === null ? previous.netDownHistory : push(previous.netDownHistory, snapshot.network.rxRate),
            netUpHistory:
              snapshot.network === null ? previous.netUpHistory : push(previous.netUpHistory, snapshot.network.txRate),
          }))
          schedule()
        },
        (error: unknown) => {
          if (disposed || controller !== inflight) return
          inflight = undefined
          // An aborted poll is our own doing (a faster tick replaced it).
          const aborted = error instanceof Error && error.name === 'AbortError'
          if (!aborted) {
            setState((previous) => ({
              ...previous,
              live: false,
              failures: previous.failures + 1,
            }))
          }
          schedule()
        },
      )
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (timer !== undefined) clearTimeout(timer)
        tick()
      }
    }

    // Poll immediately on mount so the orb has numbers before its first tick.
    tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      inflight?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return state
}
