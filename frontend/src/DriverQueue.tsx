import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Order, Robot } from './App'

export default function DriverQueue({ orders, robots, selected, onSelect, onClose, controls = false, busy = false, onCommand }: {
  orders: Order[]; robots: Robot[]; selected: string; onSelect: (id: string) => void; onClose: () => void
  controls?: boolean; busy?: boolean; onCommand?: (path: string, body?: unknown) => Promise<void>
}) {
  const [pendingAction, setPendingAction] = useState(false)
  async function command(path: string, body?: unknown) {
    if (busy || pendingAction || !onCommand) return
    setPendingAction(true)
    try { await onCommand(path, body) } finally { setPendingAction(false) }
  }
  const panel = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [position, setPosition] = useState({ left: Math.max(8, Math.min(200, window.innerWidth - 380)), top: 140 })
  const pending = orders.filter(o => o.status === 'pending' && !o.robot_id).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  const start = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    const bounds = panel.current!.getBoundingClientRect()
    drag.current = { x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current || !panel.current) return
    const bounds = panel.current.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - bounds.width - 8, drag.current.left + event.clientX - drag.current.x)),
      top: Math.max(8, Math.min(window.innerHeight - bounds.height - 8, drag.current.top + event.clientY - drag.current.y)),
    })
  }
  const end = (event: PointerEvent<HTMLElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const row = (order: Order) => <div className="driver-queue-order" key={order.id}>
    <strong>{order.id}<span>{order.quantity} шт.</span></strong>
    <p>{order.item}</p>
    <small>{({ pending: 'В очереди', assigned: 'Назначен', picking: 'Забор товара', delivering: 'Доставка', completed: 'Доставлен', cancelled: 'Отменён' })[order.status]} · приоритет {order.priority}</small>
  </div>
  return createPortal(<section ref={panel} className={`driver-queue-window ${controls ? 'fleet-control-window' : ''}`} role="dialog" aria-modal="false" aria-label={controls ? 'Все погрузчики' : 'Очередь заказов'} style={position}>
    <header onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <span aria-hidden="true">⠿</span><h2>{controls ? 'Все погрузчики' : 'Очередь заказов'}</h2>
      <button type="button" onClick={onClose} aria-label={controls ? 'Закрыть всех погрузчиков' : 'Закрыть очередь заказов'}>×</button>
    </header>
    <div className="driver-queue-scroll" tabIndex={0} aria-label="Заказы по погрузчикам и общая очередь">
      {robots.map(robot => {
        const assigned = orders.filter(o => o.robot_id === robot.id && !['completed', 'cancelled'].includes(o.status))
        return <section className={robot.id === selected ? 'is-selected' : ''} key={robot.id}>
          <button type="button" className="driver-queue-vehicle" onClick={() => onSelect(robot.id)} aria-pressed={robot.id === selected}>{robot.id}<span>{assigned.length ? `${assigned.length} в работе` : 'Нет назначений'} ↗</span></button>
          {controls && <>
            <p className="fleet-control-phase">{robot.id} — {robot.stopped_by_operator ? 'Остановлен оператором' : ({ idle: 'Свободен', offered: 'Ожидает принятия', to_pickup: 'Едет за товаром', confirm_pickup: 'Ожидает подтверждения забора', to_dropoff: 'Доставляет товар', confirm_delivery: 'Ожидает подтверждения доставки', returning: 'Возвращается на стоянку' })[robot.driver_phase]}</p>
            <div className="fleet-control-actions">
              {robot.order_id && ['offered','confirm_pickup','confirm_delivery'].includes(robot.driver_phase) && <button type="button" disabled={busy || pendingAction || robot.stopped_by_operator} onClick={() => void command(`/api/robots/${robot.id}/driver-action`, { order_id: robot.order_id, action: ({offered:'accept',confirm_pickup:'pickup',confirm_delivery:'deliver'} as Record<string,string>)[robot.driver_phase] })}>{robot.driver_phase === 'offered' ? 'Принять' : robot.driver_phase === 'confirm_pickup' ? 'Подтвердить забор' : 'Подтвердить доставку'}</button>}
              {(robot.order_id || robot.driver_phase === 'returning') && <button type="button" disabled={busy || pendingAction} onClick={() => void command(`/api/robots/${robot.id}/${robot.stopped_by_operator ? 'resume' : 'stop'}`)}>{robot.stopped_by_operator ? 'Продолжить' : 'Остановить'}</button>}
            </div>
          </>}
          {assigned.map(row)}
        </section>
      })}
      {!controls && <section className="driver-queue-pending"><h3>Не назначены <span>{pending.length}</span></h3>
        <p className="driver-queue-note">Общая очередь: менеджер выдаст допустимые заказы свободной технике.</p>
        {pending.length ? pending.map(row) : <p>Неназначенных заказов нет.</p>}
      </section>}
    </div>
  </section>, document.body)
}
