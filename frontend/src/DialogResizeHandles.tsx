import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'

/** Explicit width/height grips for every floating HTML dialog. */
export default function DialogResizeHandles() {
  const [dialogs, setDialogs] = useState<HTMLElement[]>([])
  useEffect(() => {
    const sync = () => {
      const next = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      setDialogs(previous => previous.length === next.length && previous.every((node, i) => node === next[i]) ? previous : next)
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] })
    sync()
    return () => observer.disconnect()
  }, [])
  return <>{dialogs.map((dialog, index) => createPortal(<Grips dialog={dialog} />, dialog, String(index)))}</>
}

function Grips({ dialog }: { dialog: HTMLElement }) {
  const drag = useRef<{ x: number; y: number; width: number; height: number; axis: string } | null>(null)
  const storageKey = `warehouse-dialog-size-v1:${dialog.getAttribute('aria-labelledby') || dialog.getAttribute('aria-label') || dialog.className}`
  function applySize(width: number, height: number) {
    const maxWidth = Math.max(160, window.innerWidth - 24)
    const maxHeight = Math.max(120, window.innerHeight - 24)
    dialog.style.setProperty('width', `${Math.max(Math.min(300, maxWidth), Math.min(maxWidth, width))}px`, 'important')
    dialog.style.setProperty('height', `${Math.max(Math.min(180, maxHeight), Math.min(maxHeight, height))}px`, 'important')
  }
  function saveSize() {
    const bounds = dialog.getBoundingClientRect()
    try { localStorage.setItem(storageKey, JSON.stringify({ width: bounds.width, height: bounds.height })) } catch { /* Storage may be unavailable. */ }
  }
  useLayoutEffect(() => {
    let width = dialog.classList.contains('driver-queue-window') && !dialog.classList.contains('fleet-control-window') ? 360 : 480
    let height = 320
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (saved && typeof saved.width === 'number' && Number.isFinite(saved.width) && saved.width > 0 && typeof saved.height === 'number' && Number.isFinite(saved.height) && saved.height > 0) {
        width = saved.width
        height = saved.height
      }
    } catch { /* Use the compact defaults if storage is unavailable or invalid. */ }
    applySize(width, height)
  }, [dialog, storageKey])
  function start(event: PointerEvent<HTMLButtonElement>, axis: string) {
    event.stopPropagation()
    event.preventDefault()
    const box = dialog.getBoundingClientRect()
    drag.current = { x: event.clientX, y: event.clientY, width: box.width, height: box.height, axis }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    if (!drag.current) return
    const { x, y, width, height, axis } = drag.current
    const box = dialog.getBoundingClientRect()
    applySize(axis.includes('x') ? width + event.clientX - x : box.width, axis.includes('y') ? height + event.clientY - y : box.height)
  }
  function end(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current) saveSize()
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <>{[['x', 'Изменить ширину окна'], ['y', 'Изменить высоту окна'], ['xy', 'Изменить размер окна']].map(([axis, label]) => <button key={axis} type="button" className={`dialog-resize-grip resize-${axis}`} aria-label={label} title={label} onPointerDown={event => start(event, axis)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={event => {
    if (!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const box = dialog.getBoundingClientRect()
    if (axis.includes('x') && ['ArrowLeft','ArrowRight'].includes(event.key)) dialog.style.setProperty('width', `${Math.max(280, Math.min(window.innerWidth - 24, box.width + (event.key === 'ArrowRight' ? 24 : -24)))}px`, 'important')
    if (axis.includes('y') && ['ArrowUp','ArrowDown'].includes(event.key)) dialog.style.setProperty('height', `${Math.max(180, Math.min(window.innerHeight - 24, box.height + (event.key === 'ArrowDown' ? 24 : -24)))}px`, 'important')
    saveSize()
  }}>{axis === 'xy' ? '◢' : ''}</button>)}</>
}
