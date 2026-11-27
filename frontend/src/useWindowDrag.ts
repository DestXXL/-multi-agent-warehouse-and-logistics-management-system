import { useEffect, useRef, type PointerEvent } from 'react'

// Translate the window on the compositor without rendering its contents on pointer moves.
export function useWindowDrag(identity?: unknown) {
  const panel = useRef<HTMLElement | null>(null)
  const gesture = useRef<{ x: number; y: number; left: number; top: number; bounds: DOMRect } | null>(null)
  useEffect(() => () => {
    panel.current?.style.removeProperty('translate')
    panel.current = null
    gesture.current = null
  }, [identity])

  function start(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, select, input')) return
    const dialog = event.currentTarget.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    panel.current = dialog
    const [left, top] = dialog.style.translate.split(' ').map(value => parseFloat(value) || 0)
    gesture.current = { x: event.clientX, y: event.clientY, left, top: top || 0, bounds: dialog.getBoundingClientRect() }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLElement>) {
    const g = gesture.current
    if (!g || !panel.current) return
    const dx = Math.max(8 - g.bounds.left, Math.min(innerWidth - 8 - g.bounds.right, event.clientX - g.x))
    const dy = Math.max(8 - g.bounds.top, Math.min(innerHeight - 52 - g.bounds.top, event.clientY - g.y))
    panel.current.style.setProperty('translate', `${g.left + dx}px ${g.top + dy}px`, 'important')
  }
  function end(event: PointerEvent<HTMLElement>) {
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return {start, move, end}
}
