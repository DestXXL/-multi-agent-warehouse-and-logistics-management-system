import { useState } from 'react'
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
  const pending = orders.filter(o => o.status === 'pending' && !o.robot_id).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  const row = (order: Order) => <div className="driver-queue-order" key={order.id}>
    <strong>{order.id}<span>{order.quantity} шт.</span></strong>
    <p>{order.item}</p>
    <small>{({ pending: 'В очереди', assigned: 'Назначен', picking: 'Забор товара', delivering: 'Доставка', completed: 'Доставлен', cancelled: 'Отменён' })[order.status]} · приоритет {order.priority}</small>
  </div>
  return <section className={`driver-queue-window ${controls ? 'fleet-control-window' : ''}`} aria-label={controls ? 'Все погрузчики' : 'Очередь заказов'}>
    <header>
      <span aria-hidden="true">⠿</span><h2>{controls ? 'Все погрузчики' : 'Очередь заказов'}</h2>
      <button type="button" onClick={onClose} aria-label={controls ? 'Закрыть всех погрузчиков' : 'Закрыть очередь заказов'}>×</button>
    </header>
    <div className="driver-queue-scroll" tabIndex={0} aria-label="Заказы по погрузчикам и общая очередь">
      {robots.map(robot => {
        const assigned = orders.filter(o => o.robot_id === robot.id && !['completed', 'cancelled'].includes(o.status))
        return <section className={robot.id === selected ? 'is-selected' : ''} key={robot.id}>
          <button type="button" className="driver-queue-vehicle" onClick={() => onSelect(robot.id)} aria-pressed={robot.id === selected}>{robot.id}<span>{assigned.length ? `${assigned.length} в работе` : 'Нет назначений'} ↗</span></button>
          {controls && <>
            <p className="fleet-control-phase">{robot.id} – {robot.stopped_by_operator ? 'Остановлен оператором' : ({ idle: 'Свободен', offered: 'Ожидает принятия', to_pickup: 'Едет за товаром', confirm_pickup: 'Ожидает подтверждения забора', to_dropoff: 'Доставляет товар', confirm_delivery: 'Ожидает подтверждения доставки', returning: 'Возвращается на стоянку' })[robot.driver_phase]}</p>
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
  </section>
}
