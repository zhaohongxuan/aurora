/**
 * A draggable position with localStorage persistence.
 *
 * The orb remembers where it was dropped per browser. Zoom and resizes can
 * leave a saved position outside the viewport, so the stored point is clamped
 * on restore and on every resize; a stored position that cannot be clamped
 * (the orb is larger than the window) falls back to the bottom-right corner.
 * @module aurora-system-stats/client/useDragPosition
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Distance kept between the orb and each viewport edge, in px. */
const MARGIN = 12

export interface Point {
  readonly x: number
  readonly y: number
}

interface Options {
  /** localStorage key. */
  readonly storageKey: string
  /** Element size used for clamping, in px. */
  readonly size: number
  /** The corner a fresh browser starts in. */
  readonly initial: Point
}

function read(key: string): Point | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<Point>
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

function write(key: string, point: Point): void {
  try {
    localStorage.setItem(key, JSON.stringify(point))
  } catch {
    // Private mode or a full quota: the orb simply forgets its spot.
  }
}

function clamp(point: Point, size: number): Point {
  // A shell that has not sized `window` yet reports 0; keep the point as stored
  // instead of folding it onto the top-left corner.
  const width = Number.isFinite(window.innerWidth) ? window.innerWidth : 0
  const height = Number.isFinite(window.innerHeight) ? window.innerHeight : 0
  const maxX = width - size - MARGIN
  const maxY = height - size - MARGIN
  if (maxX < MARGIN || maxY < MARGIN) return point
  return {
    x: Math.min(Math.max(point.x, MARGIN), maxX),
    y: Math.min(Math.max(point.y, MARGIN), maxY),
  }
}

export interface DragPosition {
  readonly position: Point
  /** True while a pointer drag is in flight; the panel suppresses transitions then. */
  readonly dragging: boolean
  /** Props to spread on the drag handle. */
  readonly handleProps: {
    readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
    readonly onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
    readonly onPointerUp: (event: React.PointerEvent<HTMLElement>) => void
    readonly onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void
  }
  /** Forget the saved position and go back to the initial corner. */
  readonly reset: () => void
}

export function useDragPosition(options: Options): DragPosition {
  const { storageKey, size, initial } = options
  const [position, setPosition] = useState<Point>(() => {
    const stored = read(storageKey)
    return clamp(stored ?? initial, size)
  })
  const [dragging, setDragging] = useState(false)
  const origin = useRef<{ pointer: Point; start: Point } | null>(null)
  const latest = useRef(position)
  latest.current = position

  // A resize or a zoom change can strand the orb outside the viewport.
  useEffect(() => {
    const onResize = () => setPosition((current) => clamp(current, size))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [size])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Left button and touch/pen only; a right-click keeps its context menu.
    if (event.button !== 0) return
    origin.current = {
      pointer: { x: event.clientX, y: event.clientY },
      start: latest.current,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const start = origin.current
      if (start === null) return
      // The pointer may travel outside the handle; keep the orb beside it anyway.
      const next = {
        x: start.start.x + (event.clientX - start.pointer.x),
        y: start.start.y + (event.clientY - start.pointer.y),
      }
      setPosition({ x: next.x, y: next.y })
    },
    [],
  )

  const finish = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (origin.current === null) return
      origin.current = null
      setDragging(false)
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      setPosition((current) => {
        const settled = clamp(current, size)
        write(storageKey, settled)
        return settled
      })
    },
    [size, storageKey],
  )

  const reset = useCallback(() => {
    write(storageKey, initial)
    setPosition(clamp(initial, size))
  }, [initial, size, storageKey])

  return {
    position,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
    reset,
  }
}
