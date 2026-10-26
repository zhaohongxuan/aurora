/**
 * The floating orb: a collapsed CPU ring that expands into a live metrics card.
 *
 * Docked in the frame's `shell.overlay` seat, it draws over every column without
 * taking layout space, and it keeps every bit of its own state (open, anchor,
 * position) — it reads only the shared poller and the document language.
 * @module aurora-system-stats/client/orb
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Sparkline, type RingTone } from './charts.js'
import { activeLanguage, copyFor, type Copy } from './copy.js'
import { bytes, byteParts, duration, loadTone, loadValue, pct, pct1, tone } from './format.js'
import { useDragPosition, type Point } from './useDragPosition.js'
import { useSystemStats, type StatsState } from './useStats.js'
import type { SystemStatsSnapshot } from '../types.js'
import { WaterBall } from './waterball.js'

/** Diameter of the collapsed orb, in px (matches `--aurora-orb` in styles.css). */
export const ORB_SIZE = 58
/** Panel width in px; the card is the only element with a real footprint. */
const PANEL_WIDTH = 344
/** Gap between the orb and its panel, in px. */
const PANEL_GAP = 10
/** Distance the orb keeps from each viewport edge, in px. */
const MARGIN = 12

/** The viewport, or the measured element when a shell has not sized `window` yet. */
function viewport(): { width: number; height: number } {
  const width = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1280
  const height = Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 800
  return { width, height }
}

/** The bottom-right corner a fresh browser starts from, always on screen. */
function initialPosition(): Point {
  const { width, height } = viewport()
  return {
    x: Math.max(MARGIN, width - ORB_SIZE - 24),
    y: Math.max(MARGIN, height - ORB_SIZE - 24),
  }
}
/** localStorage key for the anchor. */
const POSITION_KEY = 'aurora.system-stats.orb.position.v1'
/** localStorage key for the open flag, so a reload keeps the panel open. */
const OPEN_KEY = 'aurora.system-stats.orb.open.v1'

type Anchor = 'left' | 'right'
type Side = 'above' | 'below'

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    // Preferences are a convenience; a refused write never breaks the orb.
  }
}

/**
 * Panel placement: aligned to the orb's near edge, then flipped above when the
 * card would leave the viewport below, and finally clamped horizontally.
 * @param orb - the orb's top-left corner.
 * @param panelHeight - the measured card height.
 * @returns the anchor, the side, and the panel's top-left corner.
 */
function placePanel(orb: Point, panelHeight: number): { anchor: Anchor; side: Side; top: number; left: number } {
  const { width, height } = viewport()
  const anchor: Anchor = orb.x + ORB_SIZE / 2 < width / 2 ? 'left' : 'right'
  const left = anchor === 'left' ? orb.x : orb.x + ORB_SIZE - PANEL_WIDTH
  const below = orb.y + ORB_SIZE + PANEL_GAP + panelHeight <= height - MARGIN
  const above = orb.y - PANEL_GAP - panelHeight >= MARGIN
  const side: Side = below || !above ? 'below' : 'above'
  const top = side === 'below' ? orb.y + ORB_SIZE + PANEL_GAP : orb.y - PANEL_GAP - panelHeight
  return {
    anchor,
    side,
    left: Math.min(Math.max(left, MARGIN), Math.max(MARGIN, width - PANEL_WIDTH - MARGIN)),
    top: Math.max(MARGIN, top),
  }
}

interface StatTileProps {
  readonly label: string
  readonly value: string
  readonly unit?: string
  readonly detail: string
  readonly ratio?: number
  readonly tone?: RingTone
}

function StatTile({ label, value, unit, detail, ratio, tone: tileTone }: StatTileProps): ReactNode {
  return h(
    'div',
    { className: 'aurora-tile' },
    h('span', { className: 'aurora-tile-label' }, label),
    h(
      'span',
      { className: 'aurora-tile-value' },
      value,
      unit === undefined || unit === '' ? null : h('span', { className: 'aurora-tile-unit' }, unit),
    ),
    h('span', { className: 'aurora-tile-detail' }, detail),
    ratio === undefined
      ? null
      : h(
          'span',
          { className: 'aurora-tile-bar', role: 'presentation' },
          h('span', {
            className: `aurora-tile-fill aurora-tone-${tileTone ?? tone(ratio)}`,
            style: { width: `${Math.min(100, Math.max(2, ratio * 100))}%` },
          }),
        ),
  )
}

interface MetricRowProps {
  readonly label: string
  readonly value: string
  readonly ratio: number
  readonly tone: RingTone
  readonly history?: readonly number[]
  readonly detail?: string
}

function MetricRow({ label, value, ratio, tone: rowTone, history, detail }: MetricRowProps): ReactNode {
  return h(
    'div',
    { className: 'aurora-row' },
    h(
      'div',
      { className: 'aurora-row-head' },
      h('span', { className: 'aurora-row-label' }, label),
      h('span', { className: `aurora-row-value aurora-tone-${rowTone}` }, value),
      detail === undefined ? null : h('span', { className: 'aurora-row-detail' }, detail),
    ),
    h(
      'div',
      { className: 'aurora-row-bar' },
      h('span', {
        className: `aurora-row-fill aurora-tone-${rowTone}`,
        style: { width: `${Math.min(100, Math.max(1.5, ratio * 100))}%` },
      }),
      history === undefined || history.length < 2
        ? null
        : h(Sparkline, { points: history, tone: rowTone, width: PANEL_WIDTH - 36, height: 26, className: 'aurora-row-spark' }),
    ),
  )
}

function CoreGrid({ cores }: { readonly cores: readonly number[] }): ReactNode {
  if (cores.length === 0) return null
  return h(
    'div',
    { className: 'aurora-cores', 'aria-hidden': true },
    cores.map((value, index) =>
      h('span', {
        key: index,
        className: `aurora-core aurora-tone-${tone(value)}`,
        style: { opacity: 0.18 + Math.min(1, Math.max(0, value)) * 0.82 },
        title: pct(value),
      }),
    ),
  )
}


interface AuroraPanelProps {
  readonly snapshot: SystemStatsSnapshot
  readonly copy: Copy
  readonly stats: StatsState
  /** Live and pinned state, which changes the header controls. */
  readonly pinned: boolean
  /** Placement, or `null` while the card is being measured for the first time. */
  readonly placement: { anchor: string; side: string; top: number; left: number } | null
  readonly panelRef: React.RefObject<HTMLDivElement | null>
  /** The orb's own position; the card is positioned relative to it. */
  readonly position: Point
  readonly onReset: () => void
  readonly onClose: () => void
}

/**
 * The metrics card.
 *
 * `placement` is `null` on the first hover, when the card has to render once to be
 * measured: it then paints hidden at the origin instead of jumping into view.
 */
function AuroraPanel({ snapshot, copy, stats, pinned, placement, panelRef, position, onReset, onClose }: AuroraPanelProps): ReactNode {
  const cpuRatio = snapshot.cpuUsage
  const memRatio = snapshot.memory.ratio
  return h(
    'div',
    {
      ref: panelRef,
      className: ['aurora-panel', placement === null ? 'is-measuring' : ''].join(' ').trim(),
      role: 'dialog',
      'aria-label': copy.title,
      'data-pinned': pinned || undefined,
      'data-anchor': placement?.anchor,
      'data-side': placement?.side,
      style: {
        width: PANEL_WIDTH,
        ...(placement === null
          ? { left: 0, top: 0, visibility: 'hidden' as const }
          : { left: placement.left - position.x, top: placement.top - position.y }),
      },
    },
    h(
      'header',
      { className: 'aurora-panel-head' },
      h(
        'div',
        { className: 'aurora-panel-title' },
        h('span', { className: 'aurora-panel-name' }, copy.title),
        h('span', { className: 'aurora-panel-host' }, `${snapshot.hostname} · ${snapshot.platform}/${snapshot.arch}`),
      ),
      h(
        'div',
        { className: 'aurora-panel-actions' },
        h(
          'button',
          { type: 'button', className: 'aurora-icon-btn', title: copy.reset, 'aria-label': copy.reset, onClick: onReset },
          '⤾',
        ),
        h('button', { type: 'button', className: 'aurora-icon-btn', title: copy.collapse, 'aria-label': copy.collapse, onClick: onClose }, '✕'),
      ),
    ),
    stats.live ? null : h('div', { className: 'aurora-banner' }, copy.offline),
    h(
      'div',
      { className: 'aurora-tiles' },
      h(StatTile, {
        label: copy.cpu,
        value: pct(snapshot.cpuUsage),
        detail: `${snapshot.cpuCount} ${copy.cores}`,
        ratio: cpuRatio ?? 0,
        tone: tone(cpuRatio),
      }),
      h(StatTile, {
        label: copy.memory,
        value: pct(memRatio),
        detail: copy.usedOf(bytes(snapshot.memory.used), bytes(snapshot.memory.total)),
        ratio: memRatio,
        tone: tone(memRatio),
      }),
      h(StatTile, {
        label: copy.load,
        value: loadValue(snapshot.load[0]),
        detail: `${loadValue(snapshot.load[1])} · ${loadValue(snapshot.load[2])}`,
        ratio: snapshot.cpuCount > 0 ? Math.min(1, snapshot.load[0] / snapshot.cpuCount) : 0,
        tone: loadTone(snapshot.load[0], snapshot.cpuCount),
      }),
    ),
    h(
      'div',
      { className: 'aurora-rows' },
      h(MetricRow, {
        label: copy.cpu,
        value: pct1(snapshot.cpuUsage),
        ratio: cpuRatio ?? 0,
        tone: tone(cpuRatio),
        history: stats.cpuHistory,
      }),
      h(MetricRow, {
        label: copy.memory,
        value: pct1(memRatio),
        ratio: memRatio,
        tone: tone(memRatio),
        history: stats.memHistory,
        detail: bytes(snapshot.memory.available),
      }),
    ),
    h(CoreGrid, { cores: snapshot.cpuCores }),
    snapshot.disks.length === 0
      ? null
      : h(
          'section',
          { className: 'aurora-disks' },
          h('div', { className: 'aurora-section-title' }, copy.disk),
          snapshot.disks.map((disk) =>
            h(DiskRow, {
              key: disk.mount,
              mount: disk.mount,
              used: disk.used,
              total: disk.total,
              ratio: disk.ratio,
              title: disk.fsType === undefined ? disk.device : `${disk.device} · ${disk.fsType}`,
            }),
          ),
        ),
    h(
      'footer',
      { className: 'aurora-foot' },
      h('span', null, `${copy.uptime} ${duration(snapshot.uptime)}`),
      snapshot.swap === null ? null : h('span', null, `${copy.swap} ${pct(snapshot.swap.ratio)}`),
      h('span', { className: 'aurora-foot-spacer' }),
      h('span', null, `Node ${bytes(snapshot.proc.rss)}`),
    ),
  )
}

export interface AuroraOrbProps {
  /** Poll interval in ms; the host row's config reaches the browser through here. */
  readonly intervalMs?: number
}

/**
 * The orb and its card.
 *
 * Hovering the ball reveals the card and leaving it puts the card away; the card
 * itself is part of the same hover region, so moving the pointer from ball to card
 * keeps it open. A click pins the card open (for reading numbers) and a second
 * click releases it; Escape unpins. While the ball is being dragged the card
 * stays shut so it cannot follow the pointer around the screen.
 */
export function AuroraOrb({ intervalMs = 2000 }: AuroraOrbProps): ReactNode {
  // `hovered` is the pointer being over the ball or the card at all.
  const [hovered, setHovered] = useState(false)
  // `pinned` is the click-to-keep-open state (read, so it survives a reload).
  const [pinned, setPinned] = useState(readOpen)
  const [language, setLanguage] = useState(activeLanguage)
  const [panelHeight, setPanelHeight] = useState(320)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // A drag ends with a click; this flag keeps that gesture from pinning the card.
  const draggedRef = useRef(false)
  // Leaving the ball on the way to its card must not close the card in between,
  // so closing waits a frame longer than any gap the two parts can have.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const open = pinned || hovered
  const drag = useDragPosition({
    storageKey: POSITION_KEY,
    size: ORB_SIZE,
    initial: initialPosition(),
  })
  const stats = useSystemStats(intervalMs)
  const copy = useMemo(() => copyFor(language), [language])

  // The GUI stores its language on <html lang>: follow it when it changes.
  useEffect(() => {
    const element = document.documentElement
    const observer = new MutationObserver(() => setLanguage(activeLanguage()))
    observer.observe(element, { attributes: true, attributeFilter: ['lang'] })
    return () => observer.disconnect()
  }, [])

  // Measure the card so the flip and the clamp above/below use real numbers.
  useEffect(() => {
    const element = panelRef.current
    if (!open || element === null) return
    const measure = () => setPanelHeight(element.getBoundingClientRect().height || 320)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open])

  // Escape releases a pinned card; the hover state is the pointer's business.
  useEffect(() => {
    if (!pinned) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setPinned(false)
      writeOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pinned])

  // Never leave a pending close behind on unmount.
  useEffect(() => () => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
  }, [])

  /** Hovering either part keeps the card open; a pending close is cancelled. */
  const keep = useCallback(() => {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
    setHovered(true)
  }, [])

  /** Leaving either part closes the card unless a click pinned it. */
  const release = useCallback(() => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setHovered(false)
    }, 60)
  }, [])

  const togglePin = useCallback(() => {
    if (draggedRef.current) {
      draggedRef.current = false
      return
    }
    setPinned((current) => {
      const next = !current
      writeOpen(next)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    drag.reset()
  }, [drag])

  const snapshot = stats.snapshot
  // A card mid-drag would chase the pointer across the screen.
  const showing = open && snapshot !== undefined && !drag.dragging
  const panel = showing ? placePanel(drag.position, panelHeight) : null
  const cpuRatio = snapshot?.cpuUsage ?? 0
  const memRatio = snapshot?.memory.ratio ?? 0
  const primary = snapshot?.cpuUsage ?? snapshot?.memory.ratio ?? 0
  const primaryTone = tone(primary)

  const handleDragStart = drag.handleProps.onPointerDown
  const handleProps = {
    ...drag.handleProps,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      draggedRef.current = false
      handleDragStart(event)
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      draggedRef.current = true
      drag.handleProps.onPointerMove(event)
    },
  }

  return h(
    'div',
    {
      className: 'aurora-root',
      style: { left: drag.position.x, top: drag.position.y },
      'data-aurora-orb': true,
      'data-open': open || undefined,
      'data-pinned': pinned || undefined,
      'data-live': stats.live || undefined,
      onMouseEnter: keep,
      onMouseLeave: release,
      // Focus behaves like hover, so keyboard users get the card too.
      onFocus: keep,
      onBlur: release,
    },
    h(
      'button',
      {
        type: 'button',
        className: ['aurora-orb', `aurora-tone-${primaryTone}`, drag.dragging ? 'is-dragging' : ''].join(' '),
        'aria-label': pinned ? copy.collapse : copy.expand,
        'aria-expanded': open,
        'aria-pressed': pinned,
        title: snapshot === undefined ? copy.waiting : `${copy.cpu} ${pct(snapshot.cpuUsage)} · ${copy.memory} ${pct(memRatio)}`,
        // Click pins instead of opening: hover already opened it.
        onClick: togglePin,
        ...handleProps,
        ...(snapshot === undefined ? { 'aria-busy': true } : {}),
      },
      snapshot === undefined
        ? h('span', { className: 'aurora-orb-skeleton' })
        : h(WaterBall, {
            ratio: primary,
            tone: primaryTone,
            size: ORB_SIZE,
            live: stats.live,
            children: h(
              'span',
              { className: 'aurora-orb-label' },
              h('span', { className: 'aurora-orb-value' }, pct(primary)),
              h('span', { className: 'aurora-orb-caption' }, stats.live ? copy.cpu : '—'),
            ),
          }),
    ),
    snapshot !== undefined && showing
      ? h(AuroraPanel, {
          snapshot,
          copy,
          stats,
          pinned,
          placement: panel,
          panelRef,
          position: drag.position,
          onReset: reset,
          onClose: () => {
            setPinned(false)
            writeOpen(false)
          },
        })
      : null,
  )
}

interface DiskRowProps {
  readonly mount: string
  readonly used: number
  readonly total: number
  readonly ratio: number
  readonly title: string
}

function DiskRow({ mount, used, total, ratio, title }: DiskRowProps): ReactNode {
  const parts = byteParts(total)
  return h(
    'div',
    { className: 'aurora-disk', title },
    h('span', { className: 'aurora-disk-mount' }, mount),
    h(
      'span',
      { className: 'aurora-disk-bar' },
      h('span', {
        className: `aurora-disk-fill aurora-tone-${tone(ratio)}`,
        style: { width: `${Math.min(100, Math.max(1.5, ratio * 100))}%` },
      }),
    ),
    h('span', { className: 'aurora-disk-text' }, `${bytes(used)} / ${parts.value} ${parts.unit}`),
    h('span', { className: `aurora-disk-pct aurora-tone-${tone(ratio)}` }, pct(ratio)),
  )
}

export type { StatsState }
