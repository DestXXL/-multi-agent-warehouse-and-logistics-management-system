import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatCoordinates, formatDimensions, formatMillimeters, formatPercent, formatSquareMillimeters, occupancyPercent } from './units'

type Rack = { id: string; rack_type: string; rack_type_title: string; purpose: string; position: [number, number]; service_point: [number, number] | null; width_mm: number; depth_mm: number; height_mm: number; levels: number; positions_per_level: number; location_count: number; occupied_locations: number; free_locations: number; capacity_percent: number; package_count: number; free_surface_mm2: number; levels_occupancy: { level: number; occupied: number; total: number; packages: number; free_surface_mm2: number }[] }
type PackagePlacement = { x_mm: number; y_mm: number; length_mm: number; width_mm: number; height_mm: number; rotated: boolean }
type StoredItem = { id: string; name: string; quantity: number; length_mm: number; width_mm: number; height_mm: number; unit_placements: PackagePlacement[] }
type StorageLocation = { id: string; rack_id: string; level: number; position: number; address: string; enabled: boolean; width_mm: number; depth_mm: number; max_height_mm: number; x_mm: number; y_mm: number; occupied: boolean; package_count: number; free_surface_mm2: number; item: null | { id: string; name: string; quantity: number; reserved_quantity: number; available_quantity: number; length_mm: number; width_mm: number; height_mm: number; rotated: boolean; placement_x_mm: number; placement_y_mm: number; unit_placements: PackagePlacement[] }; items: StoredItem[] }

type Robot = {
  id: string
  position: [number, number]
  route: [number, number][]
  status: 'idle' | 'moving' | 'waiting' | 'stopped'
  order_id: string | null
  carrying_item: boolean
  stopped_by_operator: boolean
  home: [number, number]
  driver_phase: 'idle' | 'offered' | 'to_pickup' | 'confirm_pickup' | 'to_dropoff' | 'confirm_delivery' | 'returning'
  can_report_obstacle: boolean
  route_version: number
}

type Order = {
  id: string
  item: string
  pickup: [number, number]
  dropoff: [number, number]
  status: 'pending' | 'assigned' | 'picking' | 'delivering' | 'completed' | 'cancelled'
  robot_id: string | null
  item_id: string | null
  priority: number
  product_id: string | null
  quantity: number
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  storage_location_id: string | null
  allocation_index: number
  allocations: { stock_item_id: string; storage_location_id: string; quantity: number; picked: boolean; placement_snapshot: { x_mm: number; y_mm: number; length_mm: number; width_mm: number; height_mm: number; rotated: boolean }[] }[]
}

type InventoryItem = {
  id: string
  name: string
  position: [number, number]
  size: 'small' | 'medium' | 'large'
  status: 'available' | 'reserved' | 'picked' | 'delivered'
  reserved_by: string | null
  product_id: string | null
  location_id: string | null
  quantity: number
  reservations: Record<string, number>
  length_mm: number
  width_mm: number
  height_mm: number
}

type EventItem = {
  id: string
  time: string
  source: string
  robot_id?: string
  message: string
}

type State = {
  running: boolean
  tick: number
  can_create_congestion: boolean
  warehouse: {
    width: number
    height: number
    obstacles: [number, number][]
    racks: Rack[]
    storage_locations: StorageLocation[]
    closed_cells: [number, number][]
    pickup_points: [number, number][]
    shipping_points: [number, number][]
    robots: Robot[]
    orders: Order[]
    inventory: InventoryItem[]
  }
  events: EventItem[]
}

const API = `http://${window.location.hostname}:8000`

const sourceNames: Record<string, string> = {
  manager: 'МЕНЕДЖЕР',
  robot: 'ТЕХНИКА',
  driver: 'ВОДИТЕЛЬ',
  operator: 'ОПЕРАТОР',
  system: 'СИСТЕМА',
  zone: 'АГЕНТ ЗОНЫ',
}

const orderNames: Record<Order['status'], string> = {
  pending: 'В очереди',
  assigned: 'Назначен',
  picking: 'Забор товара',
  delivering: 'В пути',
  completed: 'Выполнен',
  cancelled: 'Отменён',
}

const robotNames: Record<Robot['status'], string> = {
  idle: 'Свободен',
  moving: 'В движении',
  waiting: 'Ожидает',
  stopped: 'Остановлен',
}

function key([x, y]: [number, number]) {
  return `${x},${y}`
}

function App() {
  const [state, setState] = useState<State | null>(null)
  const [connection, setConnection] = useState<'online' | 'offline'>('offline')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [rackTip, setRackTip] = useState<{ rack: Rack; anchor: HTMLElement; pinned: boolean } | null>(null)
  const [selectedRackId, setSelectedRackId] = useState<string | null>(null)
  const [, setTipPositionVersion] = useState(0)
  const [screen, setScreen] = useState<'control' | 'driver'>(() => new URLSearchParams(window.location.search).get('view') === 'driver' ? 'driver' : 'control')
  const [driverId, setDriverId] = useState(() => new URLSearchParams(window.location.search).get('vehicle') || 'R-01')
  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('view', screen)
    url.searchParams.set('vehicle', driverId)
    window.history.replaceState(null, '', url)
  }, [screen, driverId])

  useEffect(() => {
    let socket: WebSocket | null = null
    let retryTimer: number | undefined
    let disposed = false

    const connect = () => {
      if (disposed) return
      socket = new WebSocket(`${API.replace('http', 'ws')}/ws/state`)
      socket.onopen = () => {
        setConnection('online')
        setError('')
      }
      socket.onmessage = (message) => {
        try {
          setState(JSON.parse(message.data) as State)
        } catch {
          setError('Сервер прислал данные, которые не удалось прочитать.')
        }
      }
      socket.onclose = () => {
        setConnection('offline')
        retryTimer = window.setTimeout(connect, 1800)
      }
      socket.onerror = () => socket?.close()
    }

    fetch(`${API}/api/state`)
      .then((response) => {
        if (!response.ok) throw new Error('Не удалось получить состояние склада.')
        return response.json() as Promise<State>
      })
      .then(setState)
      .catch(() => setError('Backend пока не запущен. Запустите сервер по инструкции в README.'))
    connect()

    return () => {
      disposed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  const warehouse = state?.warehouse
  useEffect(() => {
    if (!rackTip) return
    const reposition = () => setTipPositionVersion(value => value + 1)
    const dismiss = (event: PointerEvent) => {
      if (!rackTip.anchor.contains(event.target as Node)) setRackTip(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setRackTip(null) }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [rackTip])

  const openRackTip = (rack: Rack, anchor: HTMLElement, pinned = false) => setRackTip({ rack, anchor, pinned })
  const robots = warehouse?.robots ?? []
  const orders = warehouse?.orders ?? []
  const inventory = warehouse?.inventory ?? []
  const completed = orders.filter((order) => order.status === 'completed').length
  const activeRobots = robots.filter((robot) => robot.status === 'moving').length
  const pending = orders.filter((order) => !['completed', 'cancelled'].includes(order.status)).length
  const driverRobot = robots.find((robot) => robot.id === driverId) ?? robots[0]
  const driverOrder = orders.find((order) => order.id === driverRobot?.order_id)
  const driverTarget = driverOrder ? (['to_pickup', 'confirm_pickup', 'offered'].includes(driverRobot?.driver_phase || '') ? driverOrder.pickup : driverOrder.dropoff) : driverRobot?.driver_phase === 'returning' ? driverRobot.home : null

  const cellMap = useMemo(() => {
    const cells = new Map<string, { obstacle?: boolean; rack?: Rack; closed?: boolean; route?: boolean; pickup?: boolean; shipping?: boolean; robot?: Robot }>()
    warehouse?.obstacles.forEach((point) => cells.set(key(point), { obstacle: true }))
    warehouse?.racks?.forEach((rack) => cells.set(key(rack.position), { ...cells.get(key(rack.position)), rack }))
    warehouse?.closed_cells.forEach((point) => cells.set(key(point), { ...cells.get(key(point)), closed: true }))
    warehouse?.pickup_points.forEach((point) => cells.set(key(point), { ...cells.get(key(point)), pickup: true }))
    warehouse?.shipping_points.forEach((point) => cells.set(key(point), { ...cells.get(key(point)), shipping: true }))
    robots.filter((robot) => screen === 'control' || robot.id === driverRobot?.id).forEach((robot) => robot.route.forEach((point) => {
      const cellKey = key(point)
      cells.set(cellKey, { ...cells.get(cellKey), route: true })
    }))
    robots.forEach((robot) => cells.set(key(robot.position), { ...cells.get(key(robot.position)), robot }))
    return cells
  }, [warehouse, robots, screen, driverRobot])

  async function command(path: string, body?: unknown) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string }
        throw new Error(problem.detail || 'Команда не выполнена.')
      }
      setState((await response.json()) as State)
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : 'Не удалось связаться с сервером.')
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return (
      <main className="connection-screen">
        <div className="brand-mark">W</div>
        <p className="eyebrow">WAREHOUSE CONTROL ROOM</p>
        <h1>Подключаем склад</h1>
        <p className="muted">{error || 'Получаем состояние симуляции…'}</p>
        <a href="http://127.0.0.1:8000/docs" target="_blank" rel="noreferrer">Открыть API сервера ↗</a>
      </main>
    )
  }

  const cells = Array.from({ length: warehouse!.width * warehouse!.height }, (_, index) => {
    const x = index % warehouse!.width
    const y = Math.floor(index / warehouse!.width)
    const cell = cellMap.get(`${x},${y}`)
    return (
      <div title={cell?.rack ? undefined : `Ячейка ${x}, ${y}`} className={`map-cell ${screen === 'driver' && driverTarget && key(driverTarget) === `${x},${y}` ? 'target-cell' : ''} ${cell?.obstacle ? 'shelf-cell' : ''} ${cell?.closed ? 'closed-cell' : ''} ${cell?.route ? 'route-cell' : ''} ${cell?.pickup ? 'pickup-cell' : ''} ${cell?.shipping ? 'shipping-cell' : ''}`} key={`${x}-${y}`}>
        {screen === 'driver' && driverTarget && key(driverTarget) === `${x},${y}` && !cell?.robot && <span className="destination-pin">ЦЕЛЬ</span>}
        {cell?.rack && <button type="button" className="shelf" aria-label={`Стеллаж ${cell.rack.id}, ${formatMillimeters(cell.rack.width_mm)} на ${formatMillimeters(cell.rack.depth_mm)} м, ${cell.rack.levels} ярусов`} aria-haspopup="dialog" aria-describedby={rackTip?.rack.id === cell.rack.id ? 'rack-tooltip' : undefined} onMouseEnter={event => openRackTip(cell.rack!, event.currentTarget)} onMouseLeave={() => setRackTip(current => current?.pinned ? current : null)} onFocus={event => openRackTip(cell.rack!, event.currentTarget)} onBlur={() => setRackTip(current => current?.pinned ? current : null)} onClick={() => { setRackTip(null); setSelectedRackId(cell.rack!.id) }}><span>▤</span><small>RACK</small></button>}
        {cell?.obstacle && !cell.rack && <div className="shelf"><span>▤</span><small>RACK</small></div>}
        {cell?.closed && <span className="closed-marker">!</span>}
        {cell?.pickup && !cell.robot && <span className="zone-pin pickup-pin">P</span>}
        {cell?.shipping && !cell.robot && <span className="zone-pin shipping-pin">OUT</span>}
        {cell?.robot && (
          <div className={`robot-token ${cell.robot.status} ${screen === 'driver' && cell.robot.id !== driverRobot?.id ? 'other-vehicle' : ''}`} title={`${cell.robot.id} · ${robotNames[cell.robot.status]}`}>
            <span className="robot-glyph">▰</span><b>{screen === 'driver' && cell.robot.id === driverRobot?.id ? 'Я' : cell.robot.id.slice(-2)}</b>
            {cell.robot.carrying_item && <i className="cargo-dot" />}
          </div>
        )}
      </div>
    )
  })

  const activeRack = rackTip && warehouse?.racks?.find(rack => rack.id === rackTip.rack.id)
  const selectedRackData = selectedRackId ? warehouse?.racks?.find(rack => rack.id === selectedRackId) : undefined
  const anchorRect = rackTip?.anchor?.getBoundingClientRect()
  const tipLeft = anchorRect ? Math.max(8, Math.min(anchorRect.left + anchorRect.width / 2 - 156, window.innerWidth - 328)) : 0
  const tipTop = anchorRect ? (anchorRect.bottom + 280 <= window.innerHeight ? anchorRect.bottom + 8 : Math.max(8, anchorRect.top - 280)) : 0

  return (
    <div className="app-shell">
      {activeRack && createPortal(<RackPreview rack={activeRack} style={{ left: tipLeft, top: tipTop }} />, document.body)}
      {selectedRackData && createPortal(<RackDetails rack={selectedRackData} locations={warehouse!.storage_locations.filter(location => location.rack_id === selectedRackData.id)} onClose={() => setSelectedRackId(null)} />, document.body)}
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark">W</div><div><strong>WAREHOUSE</strong><span>CONTROL ROOM</span></div></div>
        <div className="topbar-center"><span className={`connection-dot ${connection}`} />{connection === 'online' ? 'СВЯЗЬ С СИМУЛЯЦИЕЙ УСТАНОВЛЕНА' : 'ПОДКЛЮЧЕНИЕ К СЕРВЕРУ…'}</div>
        <div className="topbar-right"><button className="screen-switch" onClick={() => setScreen(screen === 'control' ? 'driver' : 'control')}>{screen === 'control' ? '▣ Планшет водителя' : '▦ Центр управления'}</button><span className="live-clock">SIM · {String(state.tick).padStart(4, '0')}</span><span className="avatar">{screen === 'control' ? 'ОП' : 'В-01'}</span></div>
      </header>

      <main className={`workspace ${screen === 'driver' ? 'driver-workspace' : ''}`}>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        {connection === 'offline' && <div className="workflow-error" role="status">Связь потеряна. Показано последнее известное состояние; команды недоступны.</div>}
        {screen === 'driver' ? (
          driverRobot ? <DriverTablet robot={driverRobot} robots={robots} order={driverOrder} width={warehouse!.width} cells={cells} running={state.running} busy={busy || connection !== 'online'} online={connection === 'online'} events={state.events} onSelect={setDriverId} onCommand={command} /> : <p>Нет доступного погрузчика.</p>
        ) : <>
        <section className="main-column">
          <div className="page-heading">
            <div><p className="eyebrow">ЦЕНТР УПРАВЛЕНИЯ / СМЕНА 01</p><h1>Операционная</h1><p className="muted">Мониторинг и координация складских операций</p></div>
            <div className={`simulation-badge ${state.running ? 'is-running' : ''}`}><span />{state.running ? 'СИМУЛЯЦИЯ АКТИВНА' : 'СИМУЛЯЦИЯ НА ПАУЗЕ'}</div>
          </div>

          <div className="metric-row">
            <Metric label="АКТИВНАЯ ТЕХНИКА" value={`${activeRobots} / ${robots.length}`} accent="lime" icon="✣" />
            <Metric label="ЗАКАЗЫ В РАБОТЕ" value={String(pending).padStart(2, '0')} accent="blue" icon="↗" />
            <Metric label="ВЫПОЛНЕНО В СЦЕНАРИИ" value={String(completed).padStart(2, '0')} accent="orange" icon="✓" />
            <Metric label="ТАКТ СИМУЛЯЦИИ" value={String(state.tick).padStart(4, '0')} accent="violet" icon="◷" />
          </div>

          <section className="panel map-panel">
            <div className="panel-heading map-heading">
              <div><p className="eyebrow">LIVE FLOOR PLAN</p><h2>Карта склада <span className="soft-tag">ЗОНА A · 12 × 8</span></h2></div>
              <div className="map-actions"><span className="map-live"><i /> LIVE</span><button className="icon-button" title="Обновление в реальном времени">⌁</button></div>
            </div>
            <div className="map-legend"><span><i className="legend-dot robot-dot" /> Виртуальный погрузчик</span><span><i className="legend-box rack-dot" /> Стеллаж</span><span><i className="legend-box pickup-dot" /> Комплектация</span><span><i className="legend-box shipping-dot" /> Отгрузка</span><span><i className="legend-box route-dot" /> Маршрут</span></div>
            <div className="map-scroll"><div className="warehouse-map" style={{ gridTemplateColumns: `repeat(${warehouse!.width}, minmax(42px, 1fr))` }}>{cells}</div></div>
            <div className="map-footer"><span><i className="footer-pulse" /> Карта обновляется автоматически</span><span>СХЕМА · КЛЕТКИ БЕЗ ФИЗИЧЕСКОГО МАСШТАБА</span></div>
          </section>

          <div className="lower-grid">
            <section className="panel orders-panel">
              <div className="panel-heading compact-heading"><div><p className="eyebrow">FULFILLMENT</p><h2>Очередь заказов</h2></div><span className="count-pill">{orders.length} ЗАКАЗА</span></div>
              <div className="order-list">
                {orders.map((order) => <OrderRow key={order.id} order={order} />)}
              </div>
            </section>
            <section className="panel fleet-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">FLEET STATUS</p><h2>Парк техники</h2></div><span className="fleet-count">{robots.length} ЕД.</span></div>
              <div className="fleet-list">
                {robots.map((robot) => <div className="fleet-row" key={robot.id}><div className="fleet-icon">✣</div><div className="fleet-info"><strong>{robot.id}<small>{phaseNames[robot.driver_phase]}</small></strong><span>{robot.order_id ? `Задание ${robot.order_id}` : 'Нет активного задания'}</span></div><a className="driver-link" href={`?view=driver&vehicle=${robot.id}`} target="_blank" rel="noreferrer">Планшет ↗</a><button className="stop-button" disabled={busy || connection !== 'online'} onClick={() => command(`/api/robots/${robot.id}/${robot.status === 'stopped' ? 'resume' : 'stop'}`)}>{robot.status === 'stopped' ? '▶' : 'Ⅱ'}</button></div>)}
              </div>
            </section>
          </div>
          <section className="panel inventory-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">STOCK & RESERVATIONS</p><h2>Позиции склада</h2></div><span className="count-pill">{inventory.length} ПОЗИЦИИ</span></div>
            <div className="inventory-list">
              {inventory.map((item) => <div className="inventory-row" key={item.id}><span className={`stock-box ${item.status}`}>▧</span><div className="inventory-info"><strong>{item.name}</strong><span>{item.product_id || item.id} · {item.quantity} шт. · {formatDimensions(item.length_mm, item.width_mm, item.height_mm)} · {warehouse!.storage_locations.find(location => location.id === item.location_id)?.address || 'без адреса'}</span></div><div className={`stock-status ${item.status}`}>{item.quantity - Object.values(item.reservations).reduce((sum, amount) => sum + amount, 0)} доступно</div></div>)}
            </div>
          </section>
        </section>

        <aside className="side-column">
          <section className="panel control-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">SIMULATION CONTROL</p><h2>Управление сменой</h2></div><span className={`status-ring ${state.running ? 'active' : ''}`} /></div>
            <p className="control-copy">{state.running ? 'Откройте планшет водителя: примите задание, подтвердите забор и доставку. Движение моделируется автоматически.' : 'Запустите симуляцию, чтобы начать складскую операцию.'}</p>
            <button className={`primary-button ${state.running ? 'pause-action' : ''}`} disabled={busy || connection !== 'online'} onClick={() => command(state.running ? '/api/simulation/pause' : '/api/simulation/start')}><span>{state.running ? 'Ⅱ' : '▶'}</span>{state.running ? 'Приостановить' : 'Начать симуляцию'}</button>
            <button className="congestion-button" disabled={busy || connection !== 'online' || !state.can_create_congestion} onClick={() => command('/api/simulation/congestion')}>⚠ <span>Смоделировать затор</span></button>
            <button className="secondary-button" disabled={busy || connection !== 'online'} onClick={() => { if (window.confirm('Начать заново? Задания, подтверждения и журнал текущей демонстрации будут сброшены.')) void command('/api/simulation/reset') }}>↺ <span>Сбросить склад</span></button>
            <button className="secondary-button" disabled={busy || connection !== 'online' || !warehouse!.closed_cells.length} onClick={() => command('/api/aisles/reopen')}>Открыть проходы ({warehouse!.closed_cells.length})</button>
          </section>

          <section className="panel agent-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">MULTI-AGENT SYSTEM</p><h2>Координация агентов</h2></div><span className="count-pill">3 РОЛИ</span></div>
            <div className="agent-card manager-card"><div className="agent-avatar manager-avatar">M</div><div><strong>Менеджер склада</strong><span>Приоритеты и назначения</span></div><span className="agent-indicator" /></div>
            <div className="agent-subgrid"><div className="agent-mini"><div className="agent-avatar robot-avatar">R</div><strong>Агенты техники</strong><span>Маршруты · 2 узла</span><i /></div><div className="agent-mini"><div className="agent-avatar zone-avatar">Z</div><strong>Агент зоны A</strong><span>Проходы · ячейки</span><i /></div></div>
            <div className="agent-note"><span>i</span><p>Сейчас роли работают на обычных алгоритмах без LLM. Подключение языковой модели можно добавить позже.</p></div>
          </section>

          <section className="panel activity-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">LIVE FEED</p><h2>Журнал событий</h2></div><span className="activity-live"><i /> LIVE</span></div>
            <div className="event-list">
              {state.events.slice(0, 8).map((event, index) => <div className="event-row" key={event.id}><div className={`event-line ${event.source}`}><i /></div><div className="event-copy"><div><span className={`source-label ${event.source}`}>{sourceNames[event.source] ?? event.source}</span><time>{new Date(event.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div><p>{event.message}</p></div>{index === 0 && state.running && <span className="new-event">NOW</span>}</div>)}
            </div>
            <div className="all-events">Последние 8 событий из {state.events.length}</div>
          </section>
          <div className="footnote"><span className="secure-icon">◇</span> СИМУЛЯЦИЯ · ВИРТУАЛЬНЫЙ СКЛАД</div>
        </aside>
        </>}
      </main>
    </div>
  )
}

function Metric({ label, value, accent, icon }: { label: string; value: string; accent: string; icon: string }) {
  return <div className="metric-card"><div><span className="metric-label">{label}</span><strong>{value}</strong></div><span className={`metric-icon ${accent}`}>{icon}</span></div>
}

function OrderRow({ order }: { order: Order }) {
  const addresses = order.allocations.map(allocation => `${allocation.storage_location_id} (${allocation.quantity} шт.)`).join(' · ')
  return <div className="order-row"><div className={`order-symbol ${order.status === 'completed' ? 'done' : ''}`}>{order.status === 'completed' ? '✓' : '↗'}</div><div className="order-main"><strong>{order.id}<span>{order.item} · {order.quantity} шт.</span></strong><small>{order.length_mm && order.width_mm && order.height_mm ? `${formatDimensions(order.length_mm, order.width_mm, order.height_mm)} · ` : ''}{order.robot_id ? `Погрузчик ${order.robot_id}` : 'Ожидает назначения'}{addresses ? ` · ${addresses}` : order.storage_location_id ? ` · ${order.storage_location_id}` : ''}</small></div><div className="order-state"><span className={`order-status ${order.status}`}>{orderNames[order.status]}</span><small>{order.pickup.join(', ')} → {order.dropoff.join(', ')}</small></div></div>
}

const phaseNames: Record<Robot['driver_phase'], string> = {
  returning: 'Возвращается на стоянку', idle: 'Свободен', offered: 'Ждёт принятия', to_pickup: 'Едет к товару',
  confirm_pickup: 'Ждёт подтверждения забора', to_dropoff: 'Везёт товар', confirm_delivery: 'Ждёт подтверждения доставки',
}

function DriverTablet({ robot, robots, order, width, cells, running, busy, online, events, onSelect, onCommand }: {
  robot: Robot; robots: Robot[]; order?: Order; width: number; cells: React.ReactNode;
  running: boolean; busy: boolean; online: boolean; events: EventItem[];
  onSelect: (id: string) => void; onCommand: (path: string, body?: unknown) => Promise<void>;
}) {
  const actions = {
    offered: { command: 'accept', label: 'Принять задание' },
    confirm_pickup: { command: 'pickup', label: 'Подтверждаю: товар забран' },
    confirm_delivery: { command: 'deliver', label: 'Подтверждаю: товар доставлен' },
  }
  const action = robot.driver_phase in actions ? actions[robot.driver_phase as keyof typeof actions] : null
  const destination = order ? (['offered', 'to_pickup', 'confirm_pickup'].includes(robot.driver_phase) ? order.pickup : order.dropoff) : robot.driver_phase === 'returning' ? robot.home : null
  const currentAllocation = order?.allocations[order.allocation_index]
  const step = ['offered', 'to_pickup', 'confirm_pickup', 'to_dropoff', 'confirm_delivery'].indexOf(robot.driver_phase)
  const instructions: Record<Robot['driver_phase'], string> = {
    returning: 'Доставка подтверждена. Погрузчик освобождает зону отгрузки и возвращается на стоянку.',
    idle: 'Все ваши задания завершены или пока не назначены. Ожидайте диспетчера.',
    offered: 'Проверьте товар и адреса. После принятия виртуальный погрузчик начнёт движение.',
    to_pickup: 'Следуйте к месту забора. По прибытии подтвердите, что забрали товар.',
    confirm_pickup: 'Вы у места забора. Сверьте товар с заданием и подтвердите погрузку.',
    to_dropoff: 'Товар на борту. Следуйте к месту доставки.',
    confirm_delivery: 'Вы у места доставки. Разгрузите товар и подтвердите завершение.',
  }
  return <section className="driver-tablet">
    <header className="tablet-header"><div><div className="tablet-brand"><span className="brand-mark">W</span><strong>ПЛАНШЕТ ВОДИТЕЛЯ</strong></div><label className="vehicle-select">Погрузчик <select value={robot.id} onChange={(event) => onSelect(event.target.value)}>{robots.map((vehicle) => <option key={vehicle.id}>{vehicle.id}</option>)}</select></label></div><div className="tablet-live">{online ? '● Подключён' : '○ Нет связи'} · ДЕМО</div></header>
    {!running && <div className="workflow-notice">Движение на паузе. Диспетчер может запустить или продолжить симуляцию. Подтверждения доступны.</div>}
    <div className="tablet-content">
      <section className="tablet-task panel"><div className="task-kicker"><span>ТЕКУЩЕЕ ЗАДАНИЕ</span><span className={`robot-status-pill ${robot.status}`}>{robot.stopped_by_operator ? 'Остановлен' : phaseNames[robot.driver_phase]}</span></div>
        <h1>{order?.id ?? 'Ожидание задания'}</h1><p className="task-action">{phaseNames[robot.driver_phase]}</p>
        <p className="driver-instruction">{robot.stopped_by_operator ? 'Движение остановлено. Продолжите работу, когда будете готовы.' : instructions[robot.driver_phase]}</p>
        {order && <><div className="task-product"><span className="stock-box">▧</span><div><small>ТОВАР · {order.product_id} · {order.quantity} шт.</small><strong>{order.item}</strong><small>Размер коробки · {order.length_mm != null && order.width_mm != null && order.height_mm != null ? formatDimensions(order.length_mm, order.width_mm, order.height_mm) : 'не указан'}</small><small>Адрес отбора · {order.storage_location_id || 'назначается'}</small>{currentAllocation?.placement_snapshot.length ? <small>Координаты коробок · {currentAllocation.placement_snapshot.map(position => formatCoordinates(position.x_mm, position.y_mm)).join(' · ')}</small> : null}</div></div>
        <ol className="task-steps">{['Принять', 'К товару', 'Забрать', 'К отгрузке', 'Доставить'].map((label, index) => <li key={label} className={index === step ? 'current' : index < step ? 'done' : ''}><b>{index < step ? '✓' : index + 1}</b>{label}</li>)}</ol>
        <div className="task-route"><div><span className="route-marker pickup-marker">A</span><small>ЗАБОР</small><strong>{order.pickup.join(' · ')}</strong></div><span className="route-arrow">→</span><div><span className="route-marker drop-marker">B</span><small>ДОСТАВКА</small><strong>{order.dropoff.join(' · ')}</strong></div></div></>}
        <div className="tablet-actions">
          {action && order && <button className="tablet-primary" disabled={busy || robot.stopped_by_operator} onClick={() => onCommand(`/api/robots/${robot.id}/driver-action`, { order_id: order.id, action: action.command })}>{action.label}</button>}
          <button className="tablet-secondary" disabled={busy || (!order && robot.driver_phase !== 'returning')} onClick={() => onCommand(`/api/robots/${robot.id}/${robot.stopped_by_operator ? 'resume' : 'stop'}`)}>{robot.stopped_by_operator ? '▶ Продолжить' : 'Ⅱ Приостановить движение'}</button>
          <button className="tablet-alert" disabled={busy || !robot.can_report_obstacle} onClick={() => onCommand(`/api/robots/${robot.id}/obstacle`)}>Проход передо мной перекрыт</button>
        </div>
        <p className="tablet-hint">В этом режиме движение моделируется. Забор и доставка выполняются только после вашего подтверждения.</p>
      </section>
      <section className="tablet-map panel"><div className="tablet-map-title"><div><p className="eyebrow">НАВИГАЦИЯ · {robot.id}</p><h2>{destination ? `Цель: ${destination.join(' · ')}` : 'Карта склада'}</h2></div><span className="map-live">{online ? '● На связи' : '○ Нет связи'}</span></div>
      {robot.status === 'waiting' && ['to_pickup', 'to_dropoff', 'returning'].includes(robot.driver_phase) && <div className="workflow-notice">Свободного пути нет. Ожидайте открытия прохода диспетчером.</div>}
      {robot.route_version > 0 && <div className="route-update">Маршрут пересмотрен · версия {robot.route_version}</div>}
      <div className="map-legend"><span><i className="legend-dot robot-dot" /> Вы · Я</span><span><i className="legend-box route-dot" /> Ваш маршрут</span><span>Серые метки — другая техника</span><span>! — перекрытый проход</span></div>
      <div className="map-scroll"><div className="warehouse-map tablet-warehouse-map" style={{ gridTemplateColumns: `repeat(${width}, minmax(35px, 1fr))` }}>{cells}</div></div><div className="tablet-position"><span><small>ВАША ПОЗИЦИЯ</small><strong>{robot.position.join(' · ')}</strong></span><span><small>КЛЕТОК ДО ЦЕЛИ</small><strong>{robot.route.length || (destination && key(destination) !== key(robot.position) ? '—' : '0')}</strong></span><span><small>ГРУЗ</small><strong>{robot.carrying_item ? 'На борту' : 'Пусто'}</strong></span></div>
      <div className="driver-events" aria-live="polite">{events.filter((event) => event.robot_id === robot.id).slice(0, 3).map((event) => <p key={event.id}>{event.message}</p>)}</div>
      </section>
    </div>
    <footer className="tablet-footer"><span>Виртуальный склад · координаты в клетках · без LLM</span><span>{online ? 'Подключено к симуляции' : 'Последнее известное состояние'}</span></footer>
  </section>
}

function formatCount(value: number, one: string, few: string, many: string) {
  const mod100 = value % 100
  const mod10 = value % 10
  return `${value} ${mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many}`
}

function RackPreview({ rack, style }: { rack: Rack; style: React.CSSProperties }) {
  const fill = occupancyPercent(rack.occupied_locations, rack.location_count)
  const dimensions = [
    { label: 'Ширина', value: rack.width_mm, unit: 'м' },
    { label: 'Глубина', value: rack.depth_mm, unit: 'м' },
    { label: 'Высота', value: rack.height_mm, unit: 'м' },
    { label: 'Ярусов', value: rack.levels, unit: 'ур.' },
  ]
  return <div id="rack-tooltip" role="tooltip" className="rack-tooltip" style={style}>
    <div className="rack-preview-heading"><div><span className="rack-preview-kicker">СТЕЛЛАЖ</span><strong>{rack.id}</strong></div><span className="rack-type-badge">{rack.rack_type_title}</span></div>
    <p className="rack-preview-purpose">{rack.purpose}</p>
    <div className="rack-preview-specs">{dimensions.map(dimension => <div key={dimension.label}><span>{dimension.label}</span><strong>{dimension.label === 'Ярусов' ? dimension.value : formatMillimeters(dimension.value)} <small>{dimension.unit}</small></strong></div>)}</div>
    <div className="rack-preview-chips"><span className="rack-chip occupied">Занято {rack.occupied_locations}/{rack.location_count} мест</span><span className="rack-chip boxes">{formatCount(rack.package_count, 'коробка', 'коробки', 'коробок')}</span><span className="rack-chip fill">{formatPercent(fill)}% мест занято</span><span className="rack-chip area">{formatSquareMillimeters(rack.free_surface_mm2)} свободно</span></div>
    <div className="rack-preview-progress" role="progressbar" aria-label="Занятость мест стеллажа" aria-valuenow={fill} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${fill}%` }} /></div>
  </div>
}

function RackDetails({ rack, locations, onClose }: { rack: Rack; locations: StorageLocation[]; onClose: () => void }) {
  const byLevel = new Map<number, StorageLocation[]>()
  locations.forEach(location => byLevel.set(location.level, [...(byLevel.get(location.level) || []), location]))
  const levels = [...byLevel.keys()].sort((a, b) => a - b)
  const firstOccupiedLevel = levels.find(level => byLevel.get(level)?.some(location => location.occupied)) ?? levels[0]
  const [filter, setFilter] = useState<'all' | 'occupied' | 'free'>('all')
  const [expandedLevels, setExpandedLevels] = useState<Set<number>>(() => new Set(firstOccupiedLevel === undefined ? [] : [firstOccupiedLevel]))
  const occupiedCount = locations.filter(location => location.occupied).length
  const fill = occupancyPercent(occupiedCount, rack.location_count)
  const toggleLevel = (level: number) => setExpandedLevels(previous => {
    const next = new Set(previous)
    if (next.has(level)) next.delete(level)
    else next.add(level)
    return next
  })
  const selectFilter = (nextFilter: 'all' | 'occupied' | 'free') => {
    setFilter(nextFilter)
    const firstMatchingLevel = levels.find(level => byLevel.get(level)?.some(location => nextFilter === 'all' || location.occupied === (nextFilter === 'occupied')))
    setExpandedLevels(new Set(firstMatchingLevel === undefined ? [] : [firstMatchingLevel]))
  }
  const showAllLevels = expandedLevels.size !== levels.length

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow
    const previousRootOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousRootOverflow
    }
  }, [])

  return <div className="rack-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }} onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
    <section className="rack-drawer" role="dialog" aria-modal="true" aria-labelledby="rack-drawer-title">
      <header className="rack-dialog-header"><div><p className="rack-dialog-kicker">СКЛАДСКОЕ МЕСТО</p><div className="rack-dialog-title-line"><h2 id="rack-drawer-title">Стеллаж {rack.id}</h2><span className="rack-type-badge">{rack.rack_type_title}</span></div><p className="rack-dialog-purpose">{rack.purpose}</p></div><button type="button" className="rack-dialog-close" aria-label="Закрыть карточку стеллажа" onClick={onClose}>×</button></header>
      <div className="rack-dialog-specs"><span>{formatDimensions(rack.width_mm, rack.depth_mm, rack.height_mm)}</span><i /> <span>{formatCount(rack.levels, 'ярус', 'яруса', 'ярусов')}</span></div>
      <section className="rack-summary" aria-label="Сводка стеллажа">
        <div className="rack-kpi-grid">
          <RackKpi label="Занято мест" value={`${occupiedCount}`} suffix={`/ ${rack.location_count}`} tone="amber" />
          <RackKpi label="Свободно мест" value={`${rack.free_locations}`} suffix="мест" tone="green" />
          <RackKpi label="Коробок" value={`${rack.package_count}`} suffix="всего" tone="blue" />
          <RackKpi label="Занятость мест" value={formatPercent(fill)} suffix="%" tone="violet" />
          <RackKpi label="Свободная площадь" value={formatSquareMillimeters(rack.free_surface_mm2)} suffix="" tone="green" />
          <RackKpi label="Ярусов" value={`${rack.levels}`} suffix="" tone="slate" />
        </div>
        <div className="rack-summary-progress"><div className="rack-summary-progress-label"><span>Занятость мест</span><strong>{formatPercent(fill)}%</strong></div><div className="rack-preview-progress" role="progressbar" aria-label="Занятость мест стеллажа" aria-valuenow={fill} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${fill}%` }} /></div></div>
        <p className="rack-info-note"><span aria-hidden="true">ⓘ</span> Свободная площадь может быть разделена на отдельные участки</p>
      </section>
      <div className="rack-level-toolbar"><div><h3>Содержимое по ярусам</h3><span>{formatCount(locations.length, 'место', 'места', 'мест')}</span></div><button type="button" className="rack-expand-all" onClick={() => setExpandedLevels(showAllLevels ? new Set(levels) : new Set())}>{showAllLevels ? 'Развернуть все' : 'Свернуть все'}</button></div>
      <div className="rack-filter-row" role="group" aria-label="Фильтр мест"><button type="button" className={filter === 'all' ? 'selected' : ''} onClick={() => selectFilter('all')}>Все места <span>{locations.length}</span></button><button type="button" className={filter === 'occupied' ? 'selected' : ''} onClick={() => selectFilter('occupied')}>Занятые <span>{occupiedCount}</span></button><button type="button" className={filter === 'free' ? 'selected' : ''} onClick={() => selectFilter('free')}>Свободные <span>{locations.length - occupiedCount}</span></button></div>
      <div className="rack-level-list">{levels.map(level => {
        const levelLocations = (byLevel.get(level) || []).filter(location => filter === 'all' || location.occupied === (filter === 'occupied')).sort((a, b) => a.position - b.position)
        if (!levelLocations.length) return null
        const levelInfo = rack.levels_occupancy.find(row => row.level === level)
        const isOpen = expandedLevels.has(level)
        const levelFill = levelInfo?.total ? Math.round((levelInfo.occupied / levelInfo.total) * 100) : 0
        const levelStatus = levelFill === 0 ? 'empty' : levelFill === 100 ? 'full' : 'partial'
        return <section className={`rack-level ${isOpen ? 'open' : ''}`} key={level}>
          <button type="button" className="rack-level-toggle" aria-expanded={isOpen} onClick={() => toggleLevel(level)}><span className="rack-level-title-wrap"><strong>Ярус {level}</strong><span className={`rack-level-status ${levelStatus}`}>{levelStatus === 'empty' ? 'Свободен' : levelStatus === 'full' ? 'Заполнен' : 'Частично занят'}</span></span><span className="rack-level-metrics"><span>{levelInfo?.occupied ?? 0}/{levelInfo?.total ?? 0} мест</span><span>{formatCount(levelInfo?.packages ?? 0, 'коробка', 'коробки', 'коробок')}</span><span>{formatSquareMillimeters(levelInfo?.free_surface_mm2 ?? 0)} свободно</span></span><span className={`rack-level-chevron ${isOpen ? 'expanded' : ''}`} aria-hidden="true">⌄</span></button>
          {isOpen && <div className="rack-level-slots">{levelLocations.map(location => <StorageSlot key={location.id} location={location} />)}</div>}
        </section>
      })}</div>
      {!locations.length && <div className="rack-empty-state"><span>▤</span><strong>Места пока не добавлены</strong><p>Для этого стеллажа нет данных о местах хранения.</p></div>}
    </section>
  </div>
}

function RackKpi({ label, value, suffix, tone }: { label: string; value: string; suffix: string; tone: string }) {
  return <div className={`rack-kpi ${tone}`}><span>{label}</span><strong>{value}{suffix && <small>{' '}{suffix}</small>}</strong></div>
}

type PlacementBox = { packageId: string; sequence: number; item: StoredItem; placement: PackagePlacement; issue: boolean }

function getPlacementBoxes(location: StorageLocation): { boxes: PlacementBox[]; invalidIds: Set<string>; missingCount: number } {
  const boxes = location.items.flatMap(item => item.unit_placements.map((placement, index) => ({
    packageId: `${location.id}:${item.id}:${index + 1}`,
    sequence: index + 1,
    item,
    placement,
    issue: false,
  })))
  const invalidIds = new Set<string>()
  let missingCount = 0
  for (const item of location.items) {
    if (item.unit_placements.length !== item.quantity) missingCount += Math.abs(item.quantity - item.unit_placements.length)
  }
  for (const box of boxes) {
    const { placement, item } = box
    const expectedLength = placement.rotated ? item.width_mm : item.length_mm
    const expectedWidth = placement.rotated ? item.length_mm : item.width_mm
    const values = [placement.x_mm, placement.y_mm, placement.length_mm, placement.width_mm, placement.height_mm]
    const finitePositive = values.every(Number.isFinite) && placement.length_mm > 0 && placement.width_mm > 0 && placement.height_mm > 0
    const orientationMismatch = placement.length_mm !== expectedLength || placement.width_mm !== expectedWidth
    const outside = placement.x_mm < 0 || placement.y_mm < 0 || placement.x_mm + placement.length_mm > location.width_mm || placement.y_mm + placement.width_mm > location.depth_mm
    const tooHigh = placement.height_mm > location.max_height_mm
    if (!finitePositive || orientationMismatch || outside || tooHigh) invalidIds.add(box.packageId)
  }
  for (let i = 0; i < boxes.length; i += 1) {
    const first = boxes[i].placement
    for (let j = i + 1; j < boxes.length; j += 1) {
      const second = boxes[j].placement
      const overlaps = first.x_mm < second.x_mm + second.length_mm
        && first.x_mm + first.length_mm > second.x_mm
        && first.y_mm < second.y_mm + second.width_mm
        && first.y_mm + first.width_mm > second.y_mm
      if (overlaps) {
        invalidIds.add(boxes[i].packageId)
        invalidIds.add(boxes[j].packageId)
      }
    }
  }
  return { boxes: boxes.map(box => ({ ...box, issue: invalidIds.has(box.packageId) })), invalidIds, missingCount }
}

function productColor(id: string): string {
  const colors = ['#dcebd4', '#d3e5cb', '#e5eedf', '#cfe2c5']
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return colors[hash % colors.length]
}

function StorageSlot({ location }: { location: StorageLocation }) {
  const [showAllItems, setShowAllItems] = useState(false)
  const [showPlacement, setShowPlacement] = useState(false)
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null)
  const visibleItems = showAllItems ? location.items : location.items.slice(0, 3)
  const hasHiddenItems = location.items.length > visibleItems.length
  const { boxes, invalidIds, missingCount } = getPlacementBoxes(location)
  const invalidCount = invalidIds.size + missingCount
  const numericBoxes = boxes.filter(box => [box.placement.x_mm, box.placement.y_mm, box.placement.length_mm, box.placement.width_mm].every(Number.isFinite))
  const minX = Math.min(0, ...numericBoxes.map(box => box.placement.x_mm))
  const minY = Math.min(0, ...numericBoxes.map(box => box.placement.y_mm))
  const maxX = Math.max(location.width_mm, ...numericBoxes.map(box => box.placement.x_mm + Math.max(0, box.placement.length_mm)))
  const maxY = Math.max(location.depth_mm, ...numericBoxes.map(box => box.placement.y_mm + Math.max(0, box.placement.width_mm)))
  const gridId = `placement-grid-${location.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`

  return <article className={`storage-slot ${location.occupied ? 'occupied' : 'free'}`}>
    <div className="storage-slot-heading"><div><strong>{location.address}</strong><span className={`storage-slot-status ${location.occupied ? 'occupied' : 'free'}`}>{location.occupied ? 'Занято' : 'Свободно'}</span></div>{location.package_count > 0 && <span className="storage-slot-count">{formatCount(location.package_count, 'коробка', 'коробки', 'коробок')}</span>}</div>
    <div className="storage-slot-specs"><div><span>Размер места</span><strong>{formatDimensions(location.width_mm, location.depth_mm, location.max_height_mm)}</strong></div><div><span>Свободная площадь</span><strong>{formatSquareMillimeters(location.free_surface_mm2)}</strong></div></div>
    {location.items.length ? <>
      <div className="storage-item-list">{visibleItems.map(item => <article className={`storage-item ${hoveredItemId === item.id ? 'is-highlighted' : ''}`} key={item.id} tabIndex={0} onMouseEnter={() => setHoveredItemId(item.id)} onMouseLeave={() => setHoveredItemId(null)} onFocus={() => setHoveredItemId(item.id)} onBlur={() => setHoveredItemId(null)}><span className="storage-item-icon" aria-hidden="true">▧</span><span className="storage-item-main"><strong>{item.name}</strong><small>{formatDimensions(item.length_mm, item.width_mm, item.height_mm)}</small></span><span className="storage-item-quantity">{item.quantity.toLocaleString('ru-RU')} шт.</span></article>)}</div>
      {hasHiddenItems && <button type="button" className="storage-more-button" onClick={() => setShowAllItems(true)}>Показать ещё {location.items.length - visibleItems.length}</button>}
      <button type="button" className="storage-placement-button" aria-expanded={showPlacement} onClick={() => setShowPlacement(value => !value)}>{showPlacement ? 'Скрыть размещение' : 'Показать размещение'}</button>
      {showPlacement && <div className={`storage-placement ${invalidCount ? 'has-errors' : ''}`}>
        <div className="storage-placement-heading"><strong>Схема размещения</strong><span>{formatDimensions(location.width_mm, location.depth_mm, location.max_height_mm)}</span></div>
        <svg className="storage-placement-diagram" style={{ width: `min(100%, 300px, ${240 * location.width_mm / location.depth_mm}px)` }} viewBox={`${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Схема размещения ${location.address}, ${boxes.length} коробок, размер места ${formatDimensions(location.width_mm, location.depth_mm, location.max_height_mm)}`}>
          <defs><pattern id={gridId} width="100" height="100" patternUnits="userSpaceOnUse"><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#eaf0e7" strokeWidth="2" /></pattern></defs>
          <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} fill="#f7faf5" />
          <rect x="0" y="0" width={location.width_mm} height={location.depth_mm} fill={`url(#${gridId})`} stroke="#9caf94" strokeWidth="5" />
          {boxes.map(box => {
            const { placement, item, packageId, issue } = box
            const boxLabel = `${item.name} №${box.sequence}`
            return <g key={packageId} data-package-id={packageId} className={`placement-box ${issue ? 'invalid' : ''} ${hoveredItemId === item.id ? 'highlighted' : ''}`} tabIndex={0} role="button" aria-label={`${boxLabel}, ${formatDimensions(item.length_mm, item.width_mm, item.height_mm)}, ${formatCoordinates(placement.x_mm, placement.y_mm)}${placement.rotated ? ', поворот 90 градусов' : ''}`} onMouseEnter={() => setHoveredItemId(item.id)} onMouseLeave={() => setHoveredItemId(null)} onFocus={() => setHoveredItemId(item.id)} onBlur={() => setHoveredItemId(null)}>
              <title>{`${boxLabel} · ${formatDimensions(item.length_mm, item.width_mm, item.height_mm)} · ${formatCoordinates(placement.x_mm, placement.y_mm)}${placement.rotated ? ' · поворот 90°' : ''}${issue ? ' · ошибка геометрии' : ''}`}</title>
              <rect x={placement.x_mm} y={placement.y_mm} width={placement.length_mm} height={placement.width_mm} rx="8" fill={issue ? '#f2d6d2' : productColor(item.id)} stroke={issue ? '#b34c40' : '#729366'} strokeWidth="5" />
            </g>
          })}
          <rect x="0" y="0" width={location.width_mm} height={location.depth_mm} fill="none" stroke="#748e6d" strokeWidth="5" pointerEvents="none" />
        </svg>
        <p className="storage-placement-caption">{boxes.length} коробок · координаты от левого верхнего угла места</p>
        {invalidCount > 0 && <p className="storage-placement-warning" role="alert">Обнаружено проблем с геометрией: {invalidCount}. Выход за границы показан за рамкой схемы.</p>}
      </div>}
    </> : <div className="storage-slot-empty"><span aria-hidden="true">＋</span><span>Товаров нет</span></div>}
  </article>
}
function WithLayoutLink() { return <><a style={{position:'fixed',bottom:12,right:18,zIndex:100,background:'#225dcb',color:'white',padding:'10px 16px',borderRadius:8}} href='?view=layout'>Конструктор склада ↗</a><App /></> }
export default WithLayoutLink
