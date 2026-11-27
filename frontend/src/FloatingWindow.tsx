import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'

type Rect = { left: number; top: number; width: number; height: number }
type DockSide = 'left' | 'right'
type Placement = { rect: Rect; docked: boolean; side: DockSide }
type DockTarget = Rect & { side: DockSide }
let frontLayer = 1200
let nextDockRank = 0

function fit(rect: Rect): Rect {
  const width = Math.min(Math.max(300, rect.width), Math.max(160, innerWidth - 24))
  const height = Math.min(Math.max(200, rect.height), Math.max(120, innerHeight - 24))
  return { width, height, left: Math.max(12, Math.min(innerWidth - width - 12, rect.left)), top: Math.max(12, Math.min(innerHeight - height - 12, rect.top)) }
}

export default function FloatingWindow({ id, title, children, onClose, side = 'right' }: {
  id: string; title: string; children: ReactNode; onClose: () => void; side?: 'left' | 'right'
}) {
  const storageKey = `warehouse-window-placement-v2:${id}`
  const [placement, setPlacement] = useState<Placement>(() => {
    const rect = fit({ left: (innerWidth - 600) / 2, top: (innerHeight - 520) / 2, width: 600, height: 520 })
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (saved && ['left', 'top', 'width', 'height'].every(key => typeof saved.rect?.[key] === 'number' && Number.isFinite(saved.rect[key]))) {
        const wasOldDefault = saved.rect.width === 520 && saved.rect.height === 420
        return { rect: wasOldDefault ? rect : fit(saved.rect), docked: saved.docked === true, side: saved.side === 'left' || saved.side === 'right' ? saved.side : side }
      }
    } catch { /* Use centered defaults when storage is unavailable. */ }
    return { rect, docked: false, side }
  })
  const [layer, setLayer] = useState(() => ++frontLayer)
  const [dockRank, setDockRank] = useState(() => ++nextDockRank)
  const [preview, setPreview] = useState<DockTarget | null>(null)
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = 'managed-window-host'
    return element
  })
  const home = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const gestureCleanup = useRef<(() => void) | null>(null)
  const latest = useRef(placement)
  latest.current = placement
  useLayoutEffect(() => {
    // Keep a stable portal target so docking does not reset form inputs.
    const layout = home.current?.closest('.window-layout')
    const destination = placement.docked ? layout?.querySelector<HTMLElement>(`.window-dock-rail[data-side="${placement.side}"]`) : document.body
    host.classList.toggle('is-dock-host', placement.docked)
    host.style.order = String(-dockRank)
    destination?.appendChild(host)
    if (placement.docked) {
      setDockRank(++nextDockRank)
      const rail = destination as HTMLElement | null
      if (rail) rail.scrollTop = 0
    }
    return () => host.remove()
  }, [placement.docked, placement.side, host])
  useLayoutEffect(() => { host.style.order = String(-dockRank) }, [dockRank, host])
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(placement)) } catch { /* Optional storage. */ }
  }, [placement, storageKey])
  useEffect(() => {
    const resize = () => setPlacement(current => ({ ...current, rect: fit(current.rect) }))
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); gestureCleanup.current?.() }
  }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && layer === frontLayer) onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [layer, onClose])

  function dockingArea(x: number, y: number): DockTarget | null {
    const area = home.current?.closest('.window-layout')?.getBoundingClientRect()
    if (!area || innerWidth < 900 || y < Math.max(80, area.top) || y > Math.min(innerHeight, area.bottom)) return null
    const width = Math.min(420, area.width * .25)
    const side: DockSide | null = x >= area.left && x <= area.left + width ? 'left' : x >= area.right - width && x <= area.right ? 'right' : null
    if (!side) return null
    const left = side === 'right' ? area.right - width : area.left
    return { left, side, top: Math.max(80, area.top), width, height: Math.max(160, Math.min(area.bottom, innerHeight - 12) - Math.max(80, area.top)) }
  }
  function gesture(event: ReactPointerEvent<HTMLElement>, axis: 'move' | 'x' | 'y' | 'xy') {
    if (event.button !== 0 || (axis === 'move' && (event.target as HTMLElement).closest('button, input, select, a'))) return
    event.preventDefault()
    event.stopPropagation()
    gestureCleanup.current?.()
    setLayer(++frontLayer)
    const bounds = panel.current!.getBoundingClientRect()
    // Detaching restores the last floating size, anchored beneath the pointer.
    const initial = axis === 'move' && placement.docked
      ? fit({ ...placement.rect, left: event.clientX - placement.rect.width / 2, top: event.clientY - 24 })
      : fit({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    const x = event.clientX, y = event.clientY
    let target: DockTarget | null = null
    if (axis === 'move') setPlacement({ rect: initial, docked: false, side: placement.side })
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return
      const dx = pointer.clientX - x, dy = pointer.clientY - y
      const rect = axis === 'move' ? fit({ ...initial, left: initial.left + dx, top: initial.top + dy })
        : fit({ ...initial, width: initial.width + (axis.includes('x') ? dx : 0), height: initial.height + (axis.includes('y') ? dy : 0) })
      setPlacement({ rect, docked: false, side: placement.side })
      target = axis === 'move' ? dockingArea(pointer.clientX, pointer.clientY) : null
      setPreview(target)
    }
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return
      if (pointer.type !== 'pointercancel' && target) setPlacement(current => ({ ...current, docked: true, side: target!.side }))
      setPreview(null)
      cleanup()
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      gestureCleanup.current = null
    }
    gestureCleanup.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  const windowBody = <section ref={panel} role="dialog" aria-modal="false" aria-label={title} data-managed-window="" data-docked={placement.docked ? '' : undefined}
    className={`managed-window ${placement.docked ? 'is-docked' : 'is-floating'}`}
    style={placement.docked ? undefined : { ...placement.rect, zIndex: layer }} onPointerDownCapture={() => setLayer(++frontLayer)}>
    <header className="managed-window-header" tabIndex={0} aria-label={`Переместить: ${title}`} onPointerDown={event => gesture(event, 'move')} onKeyDown={event => {
      if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault()
      setPlacement(current => ({ docked: false, side: current.side, rect: fit({ ...current.rect, left: current.rect.left + (event.key === 'ArrowRight' ? 24 : event.key === 'ArrowLeft' ? -24 : 0), top: current.rect.top + (event.key === 'ArrowDown' ? 24 : event.key === 'ArrowUp' ? -24 : 0) }) }))
    }}>
      <span aria-hidden="true">⠿</span><h2>{title}</h2>
      <button type="button" aria-label={`Закрыть: ${title}`} onClick={onClose}>×</button>
    </header>
    <div className="managed-window-body">{children}</div>
    {!placement.docked && <>{(['x', 'y', 'xy'] as const).map(axis => <button key={axis} type="button" className={`managed-resize managed-resize-${axis}`} aria-label={axis === 'x' ? `Ширина: ${title}` : axis === 'y' ? `Высота: ${title}` : `Размер: ${title}`} onPointerDown={event => gesture(event, axis)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault()
      const rect = latest.current.rect
      setPlacement({ docked: false, side: latest.current.side, rect: fit({ ...rect, width: rect.width + (axis.includes('x') ? (event.key === 'ArrowRight' ? 24 : event.key === 'ArrowLeft' ? -24 : 0) : 0), height: rect.height + (axis.includes('y') ? (event.key === 'ArrowDown' ? 24 : event.key === 'ArrowUp' ? -24 : 0) : 0) }) })
    }}>{axis === 'xy' ? '◢' : ''}</button>)}</>}
  </section>
  return <div className="window-home" ref={home} style={{ order: -dockRank }}>
    {createPortal(windowBody, host)}
    {preview && createPortal(<div className="window-snap-preview" style={{ left: preview.left, top: preview.top, width: preview.width, height: preview.height, zIndex: layer + 1 }}>Отпустите, чтобы закрепить рядом с картой</div>, document.body)}
  </div>
}

export function DockRails() {
  return <>{(['left', 'right'] as const).map(side => <aside key={side} className="window-dock-rail" data-side={side} aria-label={side === 'left' ? 'Окна слева от карты' : 'Окна справа от карты'} />)}</>
}
