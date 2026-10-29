import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import WarehouseScene from './WarehouseScene'
import { Navigation, ObjectInspector } from './ControlCenter'
import { formatCoordinates, formatDimensions, formatPercent, formatSquareMillimeters, occupancyPercent } from './units'

export type Rack = { id: string; rack_type: string; rack_type_title: string; purpose: string; position: [number, number]; service_point: [number, number] | null; width_mm: number; depth_mm: number; height_mm: number; levels: number; positions_per_level: number; location_count: number; occupied_locations: number; free_locations: number; capacity_percent: number; package_count: number; free_surface_mm2: number; levels_occupancy: { level: number; occupied: number; total: number; packages: number; free_surface_mm2: number }[] }
type PackagePlacement = { x_mm: number; y_mm: number; length_mm: number; width_mm: number; height_mm: number; rotated: boolean }
type StoredItem = { id: string; name: string; quantity: number; length_mm: number; width_mm: number; height_mm: number; unit_placements: PackagePlacement[] }
export type StorageLocation = { id: string; rack_id: string; level: number; position: number; address: string; enabled: boolean; width_mm: number; depth_mm: number; max_height_mm: number; x_mm: number; y_mm: number; occupied: boolean; package_count: number; free_surface_mm2: number; item: null | { id: string; name: string; quantity: number; reserved_quantity: number; available_quantity: number; length_mm: number; width_mm: number; height_mm: number; rotated: boolean; placement_x_mm: number; placement_y_mm: number; unit_placements: PackagePlacement[] }; items: StoredItem[] }

export type Robot = {
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

export type Order = {
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

type ToastItem = { id: string; source: string; message: string }
type OrderStatusFilter = 'all' | Order['status']
type PhysicalScale = { cellStepM: number; forkliftLengthM: number; forkliftWidthM: number }

const DEFAULT_PHYSICAL_SCALE: PhysicalScale = { cellStepM: 3, forkliftLengthM: 2.4, forkliftWidthM: 1.1 }

function readPhysicalScale(): PhysicalScale {
  try {
    const saved = JSON.parse(localStorage.getItem('warehouse-visual-scale') || 'null') as Partial<PhysicalScale> | null
    return {
      cellStepM: typeof saved?.cellStepM === 'number' && saved.cellStepM > 0 ? saved.cellStepM : DEFAULT_PHYSICAL_SCALE.cellStepM,
      forkliftLengthM: typeof saved?.forkliftLengthM === 'number' && saved.forkliftLengthM > 0 ? saved.forkliftLengthM : DEFAULT_PHYSICAL_SCALE.forkliftLengthM,
      forkliftWidthM: typeof saved?.forkliftWidthM === 'number' && saved.forkliftWidthM > 0 ? saved.forkliftWidthM : DEFAULT_PHYSICAL_SCALE.forkliftWidthM,
    }
  } catch {
    return DEFAULT_PHYSICAL_SCALE
  }
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

function key([x, y]: [number, number]) {
  return `${x},${y}`
}

function App() {
  const [state, setState] = useState<State | null>(null)
  const [connection, setConnection] = useState<'online' | 'offline'>('offline')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedRackId, setSelectedRackId] = useState<string | null>(null)
  const [detailRackId, setDetailRackId] = useState<string | null>(null)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [panelsVisible, setPanelsVisible] = useState(true)
  const [operationsVisible, setOperationsVisible] = useState(true)
  const [eventSource, setEventSource] = useState('all')
  const [orderQuery, setOrderQuery] = useState('')
  const [orderStatusFilter, setOrderStatusFilter] = useState<OrderStatusFilter>('all')
  const [highlightedRobotId, setHighlightedRobotId] = useState<string | null>(null)
  const [physicalScale, setPhysicalScale] = useState<PhysicalScale>(readPhysicalScale)
  const [physicalScaleDraft, setPhysicalScaleDraft] = useState(() => {
    const saved = readPhysicalScale()
    return { cellStepM: String(saved.cellStepM), forkliftLengthM: String(saved.forkliftLengthM), forkliftWidthM: String(saved.forkliftWidthM) }
  })
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const seenEventIds = useRef<Set<string> | null>(null)
  const toastTimers = useRef<Set<number>>(new Set())
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
        if (disposed) return
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
    retryTimer = window.setTimeout(connect, 0)

    return () => {
      disposed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  const warehouse = state?.warehouse
  useEffect(() => {
    try { localStorage.setItem('warehouse-visual-scale', JSON.stringify(physicalScale)) } catch { /* Browser storage is optional. */ }
  }, [physicalScale])
  useEffect(() => () => toastTimers.current.forEach(timer => window.clearTimeout(timer)), [])
  useEffect(() => {
    if (!state) return
    const eventIds = new Set(state.events.map(event => event.id))
    if (seenEventIds.current === null) {
      seenEventIds.current = eventIds
      return
    }
    const freshEvents = state.events.filter(event => !seenEventIds.current?.has(event.id)).slice(0, 3)
    seenEventIds.current = eventIds
    if (!freshEvents.length) return
    const nextToasts = freshEvents.slice().reverse().map(event => ({ id: event.id, source: event.source, message: event.message }))
    setToasts(current => [...nextToasts, ...current].slice(0, 4))
    nextToasts.forEach(toast => {
      const timer = window.setTimeout(() => {
        setToasts(current => current.filter(item => item.id !== toast.id))
        toastTimers.current.delete(timer)
      }, 5000)
      toastTimers.current.add(timer)
    })
  }, [state?.events])
  const robots = warehouse?.robots ?? []
  const orders = warehouse?.orders ?? []
  const inventory = warehouse?.inventory ?? []
  const completed = orders.filter((order) => order.status === 'completed').length
  const activeRobots = robots.filter((robot) => robot.status === 'moving').length
  const pending = orders.filter((order) => !['completed', 'cancelled'].includes(order.status)).length
  const driverRobot = robots.find((robot) => robot.id === driverId) ?? robots[0]
  const driverOrder = orders.find((order) => order.id === driverRobot?.order_id)
  const filteredOrders = useMemo(() => {
    const query = orderQuery.trim().toLocaleLowerCase('ru')
    return orders.filter(order => {
      const matchesStatus = orderStatusFilter === 'all' || order.status === orderStatusFilter
      const searchable = [order.id, order.item, order.product_id, order.robot_id, order.storage_location_id]
        .filter(Boolean).join(' ').toLocaleLowerCase('ru')
      return matchesStatus && (!query || searchable.includes(query))
    })
  }, [orders, orderQuery, orderStatusFilter])

  function showOrderRoute(robotId: string) {
    setHighlightedRobotId(robotId)
    setSelectedRackId(null)
    setSelectedOrderId(null)
    setPanelsVisible(true)
    window.requestAnimationFrame(() => document.getElementById('warehouse-map-panel')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }))
  }

  function updatePhysicalScale(field: keyof PhysicalScale, value: string) {
    setPhysicalScaleDraft(current => ({ ...current, [field]: value }))
    if (value.endsWith('.') || value.trim() === '') return
    const parsed = Number(value)
    const limits: Record<keyof PhysicalScale, [number, number]> = { cellStepM: [0.5, 20], forkliftLengthM: [0.5, 10], forkliftWidthM: [0.5, 5] }
    if (!Number.isFinite(parsed) || parsed < limits[field][0] || parsed > limits[field][1]) return
    setPhysicalScale(current => ({ ...current, [field]: parsed }))
  }

  function resetPhysicalScale() {
    setPhysicalScale(DEFAULT_PHYSICAL_SCALE)
    setPhysicalScaleDraft({ cellStepM: String(DEFAULT_PHYSICAL_SCALE.cellStepM), forkliftLengthM: String(DEFAULT_PHYSICAL_SCALE.forkliftLengthM), forkliftWidthM: String(DEFAULT_PHYSICAL_SCALE.forkliftWidthM) })
  }

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
        <p className="eyebrow">УПРАВЛЕНИЕ СКЛАДОМ</p>
        <h1>Подключаем склад</h1>
        <p className="muted">{error || 'Получаем состояние симуляции…'}</p>
        <a href="http://127.0.0.1:8000/docs" target="_blank" rel="noreferrer">Открыть API сервера ↗</a>
      </main>
    )
  }

  const selectedRackData = selectedRackId ? warehouse?.racks?.find(rack => rack.id === selectedRackId) : undefined
  const detailRackData = warehouse?.racks.find(rack => rack.id === detailRackId)
  const selectedRobot = robots.find(robot => robot.id === highlightedRobotId)
  const selectedOrder = orders.find(order => order.id === selectedOrderId)
  const selectRack = (id: string) => { setSelectedRackId(id); setHighlightedRobotId(null); setSelectedOrderId(null); setPanelsVisible(true) }
  const selectRobot = (id: string) => { setHighlightedRobotId(id); setSelectedRackId(null); setSelectedOrderId(null); setPanelsVisible(true) }
  const visibleEvents = state.events.filter(event => eventSource === 'all' || event.source === eventSource)
  return (
    <div className={`app-shell ${panelsVisible ? '' : 'panels-hidden'} ${operationsVisible ? '' : 'operations-hidden'}`}>
      <Navigation screen={screen} onChange={setScreen} />
      {detailRackData && createPortal(<RackDetails key={detailRackData.id} rack={detailRackData} locations={warehouse!.storage_locations.filter(location => location.rack_id === detailRackData.id)} onClose={() => setDetailRackId(null)} />, document.body)}
      {toasts.length > 0 && <div className="toast-stack" role="status" aria-live="polite">{toasts.map(toast => <div className="event-toast" key={toast.id}><span className={`toast-source ${toast.source}`} /><p>{toast.message}</p><button type="button" aria-label="Закрыть уведомление" onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}>×</button></div>)}</div>}
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark">W</div><div><strong>Центр управления складом</strong><span>Управление складом и логистикой</span></div></div>
        <div className="topbar-center"><span className={`connection-dot ${connection}`} />{connection === 'online' ? 'На связи' : 'Нет связи'}</div>
        <div className="topbar-right"><span className={`simulation-badge ${state.running ? 'is-running' : ''}`}><span />{state.running ? 'Симуляция активна' : 'На паузе'}</span><button className="header-start" disabled={busy || connection !== 'online'} onClick={() => command(state.running ? '/api/simulation/pause' : '/api/simulation/start')}>{state.running ? 'Ⅱ Пауза' : '▶ Запустить'}</button><span className="live-clock">Такт · {String(state.tick).padStart(4, '0')}</span><span className="avatar">{screen === 'control' ? 'ОП' : 'В-01'}</span></div>
      </header>

      <main className={`workspace ${screen === 'driver' ? 'driver-workspace' : ''}`}>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        {connection === 'offline' && <div className="workflow-error" role="status">Связь потеряна. Показано последнее известное состояние; команды недоступны.</div>}
        {screen === 'driver' ? (
          driverRobot ? <DriverTablet robot={driverRobot} robots={robots} order={driverOrder} cells={<WarehouseScene warehouse={warehouse!} scale={physicalScale} selectedRack={selectedRackId} selectedRobot={driverRobot.id} target={driverOrder ? (['offered', 'to_pickup', 'confirm_pickup'].includes(driverRobot.driver_phase) ? driverOrder.pickup : driverOrder.dropoff) : driverRobot.driver_phase === 'returning' ? driverRobot.home : null} onRack={id => setDetailRackId(id)} onRobot={setDriverId} />} physicalScale={physicalScale} running={state.running} busy={busy || connection !== 'online'} online={connection === 'online'} events={state.events} onSelect={setDriverId} onCommand={command} /> : <p>Нет доступного погрузчика.</p>
        ) : <>
        <section className="main-column">
          <div className="page-heading">
            <div><h1>Диспетчерская</h1><p className="muted">Склад {warehouse!.width} × {warehouse!.height} клеток · {warehouse!.racks.length} стеллажей · схема ≈ { (warehouse!.width * physicalScale.cellStepM).toLocaleString("ru") } × { (warehouse!.height * physicalScale.cellStepM).toLocaleString("ru") } м</p></div>
            <div className="workspace-actions"><button type="button" aria-expanded={operationsVisible} onClick={() => setOperationsVisible(value => !value)}>{operationsVisible ? 'Скрыть операции' : 'Операции'}</button><button type="button" aria-expanded={panelsVisible} onClick={() => setPanelsVisible(value => !value)}>{panelsVisible ? 'Скрыть панель' : 'Панель объектов'}</button></div>
          </div>

          <div className="metric-row">
            <Metric label="АКТИВНАЯ ТЕХНИКА" value={`${activeRobots} / ${robots.length}`} accent="lime" icon="✣" />
            <Metric label="НЕЗАВЕРШЁННЫЕ ЗАКАЗЫ" value={String(pending).padStart(2, '0')} accent="blue" icon="↗" />
            <Metric label="ВЫПОЛНЕНО В СЦЕНАРИИ" value={String(completed).padStart(2, '0')} accent="orange" icon="✓" />
            <Metric label="ТАКТ СИМУЛЯЦИИ" value={String(state.tick).padStart(4, '0')} accent="violet" icon="◷" />
          </div>

          <section className="panel map-panel" id="warehouse-map-panel">
            <div className="panel-heading map-heading">
              <div><h2>Карта склада <span className="soft-tag">{warehouse!.width} × {warehouse!.height} клеток</span></h2></div>
              <div className="map-actions"><span className="map-live">{connection === 'online' ? (state.running ? 'Выполняется' : 'На паузе') : 'Нет связи'}</span></div>
            </div>
            <details className="scale-settings"><summary>Масштаб и габариты техники</summary><div className="map-dimension-controls"><label title="Расстояние между центрами соседних клеток">Шаг сетки <span><input type="number" min="0.5" max="20" step="0.1" value={physicalScaleDraft.cellStepM} onChange={event => updatePhysicalScale('cellStepM', event.target.value)} onBlur={() => setPhysicalScaleDraft(current => ({ ...current, cellStepM: String(physicalScale.cellStepM) }))} /> м</span></label><label>Погрузчик Д × Ш <span><input type="number" min="0.5" max="10" step="0.1" value={physicalScaleDraft.forkliftLengthM} onChange={event => updatePhysicalScale('forkliftLengthM', event.target.value)} onBlur={() => setPhysicalScaleDraft(current => ({ ...current, forkliftLengthM: String(physicalScale.forkliftLengthM) }))} aria-label="Длина погрузчика в метрах" /> × <input type="number" min="0.5" max="5" step="0.1" value={physicalScaleDraft.forkliftWidthM} onChange={event => updatePhysicalScale('forkliftWidthM', event.target.value)} onBlur={() => setPhysicalScaleDraft(current => ({ ...current, forkliftWidthM: String(physicalScale.forkliftWidthM) }))} aria-label="Ширина погрузчика в метрах" /> м</span></label><button type="button" onClick={resetPhysicalScale}>Демо значения</button><small>Примерный шаг сетки · ширина стеллажей по X, глубина по Y; локальная настройка схемы, не параметры симуляции</small></div></details>
            <div className="map-legend"><span><i className="legend-dot robot-dot" /> Погрузчик</span><span><i className="legend-box rack-dot" /> Стеллаж</span><span><i className="legend-box pickup-dot" /> Комплектация</span><span><i className="legend-box shipping-dot" /> Отгрузка</span><span><i className="legend-box route-dot" /> {highlightedRobotId ? `Маршрут ${highlightedRobotId}` : 'Маршрут по выбору'}</span><span><i className="legend-box aisle-dot" /> Проезд · м</span><span className="aisle-warning-legend">Красный – уже погрузчика</span>{highlightedRobotId && <button className="clear-route-button" type="button" onClick={() => setHighlightedRobotId(null)}>Снять выделение</button>}</div>
            <WarehouseScene warehouse={warehouse!} scale={physicalScale} selectedRack={selectedRackId} selectedRobot={highlightedRobotId} onRack={selectRack} onRobot={selectRobot} />
            <div className="map-footer"><span><i className="footer-pulse" /> Карта обновляется автоматически</span><span>Выберите объект для подробностей</span></div>
          </section>

          <ObjectInspector rack={selectedRackData} robot={selectedOrder ? undefined : selectedRobot} order={selectedOrder} phase={selectedRobot ? phaseNames[selectedRobot.driver_phase] : undefined} status={selectedOrder ? orderNames[selectedOrder.status] : undefined} onClose={() => { setSelectedRackId(null); setHighlightedRobotId(null); setSelectedOrderId(null) }} onRackDetails={() => setDetailRackId(selectedRackId)} />
          <div className="lower-grid">
            <section className="panel orders-panel" id="orders">
              <div className="panel-heading compact-heading"><div><p className="eyebrow">ЗАКАЗЫ</p><h2>Очередь заказов</h2></div><span className="count-pill">{filteredOrders.length} / {orders.length}</span></div>
              <div className="order-tools"><div className="order-search"><span aria-hidden="true">⌕</span><input value={orderQuery} onChange={event => setOrderQuery(event.target.value)} placeholder="Найти заказ или товар" aria-label="Поиск заказов" /><button type="button" aria-label="Очистить поиск" onClick={() => setOrderQuery('')} disabled={!orderQuery}>×</button></div><label className="order-filter"><span>Статус</span><select value={orderStatusFilter} onChange={event => setOrderStatusFilter(event.target.value as OrderStatusFilter)} aria-label="Фильтр по статусу"><option value="all">Все</option>{Object.entries(orderNames).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label></div>
              <div className="order-list">
                {filteredOrders.map((order) => <OrderRow key={order.id} order={order} highlightedRobotId={highlightedRobotId} onShowRoute={showOrderRoute} onSelect={() => { setSelectedOrderId(order.id); setSelectedRackId(null); setHighlightedRobotId(order.robot_id); setPanelsVisible(true) }} />)}
                {filteredOrders.length === 0 && <div className="order-empty">Заказы по этому запросу не найдены.</div>}
              </div>
            </section>
          <section className="panel activity-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">СОБЫТИЯ</p><h2>Журнал событий</h2></div><span className="activity-live">{connection === 'online' ? (state.running ? 'Выполняется' : 'На паузе') : 'Нет связи'}</span></div>
            <label className="event-filter">Источник <select value={eventSource} onChange={event => setEventSource(event.target.value)}><option value="all">Все события</option>{Object.entries(sourceNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="event-list">
              {visibleEvents.slice(0, 30).map((event, index) => <div className="event-row" key={event.id}><div className={`event-line ${event.source}`}><i /></div><div className="event-copy"><div><span className={`source-label ${event.source}`}>{sourceNames[event.source] ?? event.source}</span><time>{new Date(event.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div><p>{event.message}</p></div>{index === 0 && state.running && <span className="new-event">Сейчас</span>}</div>)}
            </div>
            <div className="all-events">Показано {Math.min(30, visibleEvents.length)} из {visibleEvents.length} событий</div>
          </section>
            <section className="panel fleet-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">ТЕХНИКА</p><h2>Парк техники</h2></div><span className="fleet-count">{robots.length} ЕД.</span></div>
              <div className="fleet-list">
                {robots.map((robot) => <div className={`fleet-row ${highlightedRobotId === robot.id ? 'is-selected' : ''}`} key={robot.id}><div className="fleet-icon">✣</div><div className="fleet-info"><strong>{robot.id}<small>{phaseNames[robot.driver_phase]}</small></strong><span>{robot.order_id ? `Задание ${robot.order_id}` : 'Нет активного задания'}</span></div><button type="button" className="fleet-map-button" aria-pressed={highlightedRobotId === robot.id} onClick={() => selectRobot(robot.id)}>{highlightedRobotId === robot.id ? 'На карте ✓' : 'Показать'}</button><a className="driver-link" href={`?view=driver&vehicle=${robot.id}`} target="_blank" rel="noreferrer">Планшет ↗</a><button className="stop-button" aria-label={`${robot.status === 'stopped' ? 'Продолжить' : 'Остановить'} ${robot.id}`} disabled={busy || connection !== 'online'} onClick={() => command(`/api/robots/${robot.id}/${robot.status === 'stopped' ? 'resume' : 'stop'}`)}>{robot.status === 'stopped' ? '▶' : 'Ⅱ'}</button></div>)}
              </div>
            </section>
          </div>
          <section className="panel inventory-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">ЗАПАСЫ И РЕЗЕРВЫ</p><h2>Позиции склада</h2></div><span className="count-pill">{inventory.length} ПОЗИЦИИ</span></div>
            <div className="inventory-list">
              {inventory.map((item) => <div className="inventory-row" key={item.id}><span className={`stock-box ${item.status}`}>▧</span><div className="inventory-info"><strong>{item.name}</strong><span>{item.product_id || item.id} · {item.quantity} шт. · {formatDimensions(item.length_mm, item.width_mm, item.height_mm)} · {warehouse!.storage_locations.find(location => location.id === item.location_id)?.address || 'без адреса'}</span></div><div className={`stock-status ${item.status}`}>{item.quantity - Object.values(item.reservations).reduce((sum, amount) => sum + amount, 0)} доступно</div></div>)}
            </div>
          </section>
        </section>

        <aside className="side-column">

          <section className="panel control-panel">
            <div className="panel-heading compact-heading"><div><p className="eyebrow">СИМУЛЯЦИЯ</p><h2>Управление сменой</h2></div><span className={`status-ring ${state.running ? 'active' : ''}`} /></div>
            <p className="control-copy">{state.running ? 'Откройте планшет водителя: примите задание, подтвердите забор и доставку. Движение моделируется автоматически.' : 'Запустите симуляцию, чтобы начать складскую операцию.'}</p>
            <button className={`primary-button ${state.running ? 'pause-action' : ''}`} disabled={busy || connection !== 'online'} onClick={() => command(state.running ? '/api/simulation/pause' : '/api/simulation/start')}><span>{state.running ? 'Ⅱ' : '▶'}</span>{state.running ? 'Приостановить' : 'Начать симуляцию'}</button>
            <button className="congestion-button" disabled={busy || connection !== 'online' || !state.can_create_congestion} onClick={() => command('/api/simulation/congestion')}>⚠ <span>Смоделировать затор</span></button>
            <button className="secondary-button" disabled={busy || connection !== 'online'} onClick={() => { if (window.confirm('Начать заново? Задания, подтверждения и журнал текущей демонстрации будут сброшены.')) void command('/api/simulation/reset') }}>↺ <span>Сбросить склад</span></button>
            <button className="secondary-button" disabled={busy || connection !== 'online' || !warehouse!.closed_cells.length} onClick={() => command('/api/aisles/reopen')}>Открыть проходы ({warehouse!.closed_cells.length})</button>
          </section>

          <details className="panel agent-panel"><summary>Как работают агенты склада</summary>
            <div className="panel-heading compact-heading"><div><p className="eyebrow">СПРАВКА</p><h2>Координация агентов</h2></div><span className="count-pill">3 РОЛИ</span></div>
            <div className="agent-card manager-card"><div className="agent-avatar manager-avatar">M</div><div><strong>Менеджер склада</strong><span>Приоритеты и назначения</span></div><span className="agent-indicator" /></div>
            <div className="agent-subgrid"><div className="agent-mini"><div className="agent-avatar robot-avatar">R</div><strong>Агенты техники</strong><span>Маршруты · {robots.length} ед.</span><i /></div><div className="agent-mini"><div className="agent-avatar zone-avatar">Z</div><strong>Агент зоны</strong><span>Проходы · ячейки</span><i /></div></div>
            <div className="agent-note"><span>i</span><p>Менеджер назначает задания, планировщик строит маршруты, агент зоны учитывает перекрытия. Решения и действия отражены в журнале.</p></div>
          </details>

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

function OrderRow({ order, highlightedRobotId, onShowRoute, onSelect }: { order: Order; highlightedRobotId: string | null; onShowRoute: (robotId: string) => void; onSelect: () => void }) {
  const addresses = order.allocations.map(allocation => `${allocation.storage_location_id} (${allocation.quantity} шт.)`).join(' · ')
  return <div className="order-row"><div className={`order-symbol ${order.status === 'completed' ? 'done' : ''}`}>{order.status === 'completed' ? '✓' : '↗'}</div><div className="order-main"><strong><button type="button" className="order-detail-button" onClick={onSelect}>{order.id} ↗</button><span>{order.item} · {order.quantity} шт.</span></strong><small>{order.length_mm && order.width_mm && order.height_mm ? `${formatDimensions(order.length_mm, order.width_mm, order.height_mm)} · ` : ''}{order.robot_id ? `Погрузчик ${order.robot_id}` : 'Ожидает назначения'}{addresses ? ` · ${addresses}` : order.storage_location_id ? ` · ${order.storage_location_id}` : ''}</small></div><div className="order-state"><span className={`order-status ${order.status}`}>{orderNames[order.status]}</span><small>Забор: {order.storage_location_id || order.pickup.join(', ')}<br />Отгрузка: клетка {order.dropoff.join(', ')}</small>{order.robot_id && <button className="order-map-action" type="button" aria-pressed={highlightedRobotId === order.robot_id} onClick={() => onShowRoute(order.robot_id!)}>{highlightedRobotId === order.robot_id ? 'Маршрут выбран' : 'Показать маршрут ↗'}</button>}</div></div>
}

const phaseNames: Record<Robot['driver_phase'], string> = {
  returning: 'Возвращается на стоянку', idle: 'Свободен', offered: 'Ждёт принятия', to_pickup: 'Едет к товару',
  confirm_pickup: 'Ждёт подтверждения забора', to_dropoff: 'Везёт товар', confirm_delivery: 'Ждёт подтверждения доставки',
}

function DriverTablet({ robot, robots, order, cells, physicalScale, running, busy, online, events, onSelect, onCommand }: {
  robot: Robot; robots: Robot[]; order?: Order; cells: React.ReactNode; physicalScale: PhysicalScale;
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
      <section className="tablet-map panel"><div className="tablet-map-title"><div><p className="eyebrow">НАВИГАЦИЯ · {robot.id}</p><h2>{destination ? `Цель: ${destination.join(' · ')}` : 'Карта склада'}</h2><small className="tablet-dimensions">Шаг сетки {physicalScale.cellStepM.toFixed(1)} м · габарит {physicalScale.forkliftLengthM.toFixed(1)} × {physicalScale.forkliftWidthM.toFixed(1)} м (демо)</small></div><span className="map-live">{online ? '● На связи' : '○ Нет связи'}</span></div>
      {robot.status === 'waiting' && ['to_pickup', 'to_dropoff', 'returning'].includes(robot.driver_phase) && <div className="workflow-notice">Свободного пути нет. Ожидайте открытия прохода диспетчером.</div>}
      {robot.route_version > 0 && <div className="route-update">Маршрут пересмотрен · версия {robot.route_version}</div>}
      <div className="map-legend"><span><i className="legend-dot robot-dot" /> Выбранный погрузчик</span><span><i className="legend-box route-dot" /> Ваш маршрут</span><span>Маршрут выбранного погрузчика</span><span>! – перекрытый проход</span></div>
      <div className="tablet-scene">{cells}</div><div className="tablet-position"><span><small>ВАША ПОЗИЦИЯ</small><strong>{robot.position.join(' · ')}</strong></span><span><small>КЛЕТОК ДО ЦЕЛИ</small><strong>{robot.route.length || (destination && key(destination) !== key(robot.position) ? '–' : '0')}</strong></span><span><small>ГРУЗ</small><strong>{robot.carrying_item ? 'На борту' : 'Пусто'}</strong></span></div>
      <div className="driver-events" aria-live="polite">{events.filter((event) => event.robot_id === robot.id).slice(0, 3).map((event) => <p key={event.id}>{event.message}</p>)}</div>
      </section>
    </div>
    <footer className="tablet-footer"><span>Виртуальный склад · координаты в клетках</span><span>{online ? 'Подключено к симуляции' : 'Последнее известное состояние'}</span></footer>
  </section>
}

function formatCount(value: number, one: string, few: string, many: string) {
  const mod100 = value % 100
  const mod10 = value % 10
  return `${value} ${mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many}`
}

function RackDetails({ rack, locations, onClose }: { rack: Rack; locations: StorageLocation[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, [tabindex="0"]') ?? [])]
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); previous?.focus() }
  }, [])
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
    <section ref={dialogRef} className="rack-drawer" role="dialog" aria-modal="true" aria-labelledby="rack-drawer-title">
      <header className="rack-dialog-header"><div><p className="rack-dialog-kicker">СКЛАДСКОЕ МЕСТО</p><div className="rack-dialog-title-line"><h2 id="rack-drawer-title">Стеллаж {rack.id}</h2><span className="rack-type-badge">{rack.rack_type_title}</span></div><p className="rack-dialog-purpose">{rack.purpose}</p></div><button type="button" className="rack-dialog-close" aria-label="Закрыть карточку стеллажа" onClick={onClose}>×</button></header>
      <div className="rack-dialog-body">
      <div className="rack-dialog-specs"><span>{formatDimensions(rack.width_mm, rack.depth_mm, rack.height_mm)}</span><i /> <span>{formatCount(rack.levels, 'ярус', 'яруса', 'ярусов')}</span></div>
      <section className="rack-summary" aria-label="Сводка стеллажа">
        <div className="rack-kpi-grid">
          <RackKpi label="Занято мест" value={`${occupiedCount}`} suffix={`/ ${rack.location_count}`} tone="amber" />
          <RackKpi label="Свободно мест" value={`${rack.free_locations}`} suffix="мест" tone="green" />
          <RackKpi label="Коробок" value={`${rack.package_count}`} suffix="всего" tone="blue" />

          <RackKpi label="Свободная площадь" value={formatSquareMillimeters(rack.free_surface_mm2)} suffix="" tone="green" />

        </div>
        <div className="rack-summary-progress"><div className="rack-summary-progress-label"><span>Занятость мест</span><strong>{formatPercent(fill)}%</strong></div><div className="rack-preview-progress" role="progressbar" aria-label="Занятость мест стеллажа" aria-valuenow={fill} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${fill}%` }} /></div></div>
        <p className="rack-info-note"><span aria-hidden="true">ⓘ</span> Место – участок полки для нескольких коробок. Свободная площадь суммируется по всем полкам.</p>
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
      </div>
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
  const colors = ['#456e61', '#4d7969', '#527d70', '#41695d']
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
  const diagramWidth = Math.max(1, maxX - minX)
  const diagramDepth = Math.max(1, maxY - minY)

  return <article className={`storage-slot ${location.occupied ? 'occupied' : 'free'} ${showPlacement ? 'has-placement' : ''}`}>
    <div className="storage-slot-heading"><div><strong>{location.address}</strong><span className={`storage-slot-status ${location.occupied ? 'occupied' : 'free'}`}>{location.occupied ? 'Занято' : 'Свободно'}</span></div>{location.package_count > 0 && <span className="storage-slot-count">{formatCount(location.package_count, 'коробка', 'коробки', 'коробок')}</span>}</div>
    <div className="storage-slot-content">
    <div className="storage-slot-specs"><div><span>Размер места</span><strong>{formatDimensions(location.width_mm, location.depth_mm, location.max_height_mm)}</strong></div><div><span>Свободная площадь</span><strong>{formatSquareMillimeters(location.free_surface_mm2)}</strong></div></div>
    {location.items.length ? <>
      <div className="storage-item-list">{visibleItems.map(item => <article className={`storage-item ${hoveredItemId === item.id ? 'is-highlighted' : ''}`} key={item.id} tabIndex={0} onMouseEnter={() => setHoveredItemId(item.id)} onMouseLeave={() => setHoveredItemId(null)} onFocus={() => setHoveredItemId(item.id)} onBlur={() => setHoveredItemId(null)}><span className="storage-item-icon" aria-hidden="true">▧</span><span className="storage-item-main"><strong>{item.name}</strong><small>{formatDimensions(item.length_mm, item.width_mm, item.height_mm)}</small></span><span className="storage-item-quantity">{item.quantity.toLocaleString('ru-RU')} шт.</span></article>)}</div>
      {(hasHiddenItems || showAllItems) && location.items.length > 3 && <button type="button" className="storage-more-button" aria-expanded={showAllItems} onClick={() => setShowAllItems(value => !value)}>{showAllItems ? 'Свернуть содержимое' : `Показать ещё ${location.items.length - visibleItems.length}`}</button>}
    </> : <div className="storage-slot-empty"><span aria-hidden="true">＋</span><span>Товаров нет</span></div>}
    </div>
      <button type="button" className="storage-placement-button" aria-expanded={showPlacement} onClick={() => setShowPlacement(value => !value)}>{showPlacement ? 'Скрыть размещение' : 'Показать размещение'}</button>
      {showPlacement && <div className={`storage-placement ${invalidCount ? 'has-errors' : ''}`}>
        <div className="storage-placement-heading"><div><strong>Схема размещения</strong><span>Вид сверху</span></div><span>{formatDimensions(location.width_mm, location.depth_mm, location.max_height_mm)}</span></div>
        <div className="storage-placement-canvas">
        <svg className="storage-placement-diagram" style={{ width: `min(100%, calc(var(--placement-height) * ${diagramWidth / diagramDepth}))`, aspectRatio: `${diagramWidth} / ${diagramDepth}` }} viewBox={`${minX} ${minY} ${diagramWidth} ${diagramDepth}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Вид сверху: ${location.address}, ${formatCount(numericBoxes.length, 'коробка', 'коробки', 'коробок')}, размер места ${formatDimensions(location.width_mm, location.depth_mm, location.max_height_mm)}`}>
          <defs><pattern id={gridId} width="100" height="100" patternUnits="userSpaceOnUse"><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#a0b9cc" strokeOpacity=".12" strokeWidth=".5" vectorEffect="non-scaling-stroke" /></pattern></defs>
          <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} fill="#101a22" />
          <rect x="0" y="0" width={location.width_mm} height={location.depth_mm} fill={`url(#${gridId})`} />
          {numericBoxes.map(box => {
            const { placement, item, packageId, issue } = box
            const boxLabel = `${item.name} №${box.sequence}`
            return <g key={packageId} data-package-id={packageId} className={`placement-box ${issue ? 'invalid' : ''} ${hoveredItemId === item.id ? 'highlighted' : ''}`} tabIndex={0} role="button" aria-label={`${boxLabel}, ${formatDimensions(item.length_mm, item.width_mm, item.height_mm)}, ${formatCoordinates(placement.x_mm, placement.y_mm)}${placement.rotated ? ', поворот 90 градусов' : ''}`} onMouseEnter={() => setHoveredItemId(item.id)} onMouseLeave={() => setHoveredItemId(null)} onFocus={() => setHoveredItemId(item.id)} onBlur={() => setHoveredItemId(null)}>
              <title>{`${boxLabel} · ${formatDimensions(item.length_mm, item.width_mm, item.height_mm)} · ${formatCoordinates(placement.x_mm, placement.y_mm)}${placement.rotated ? ' · поворот 90°' : ''}${issue ? ' · ошибка геометрии' : ''}`}</title>
              <rect x={placement.x_mm} y={placement.y_mm} width={Math.max(0, placement.length_mm)} height={Math.max(0, placement.width_mm)} fill={issue ? '#7c3c47' : productColor(item.id)} stroke={issue ? '#e66d75' : '#90c4a9'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            </g>
          })}
          <rect x="0" y="0" width={location.width_mm} height={location.depth_mm} fill="none" stroke="#648293" strokeWidth="1" vectorEffect="non-scaling-stroke" pointerEvents="none" />
        </svg>
        </div>
        <div className="storage-placement-footer"><div className="storage-placement-legend" aria-label="Легенда схемы"><span><i className="occupied" />Занято</span><span><i className="free" />Свободно</span></div><span>{formatCount(numericBoxes.length, 'коробка', 'коробки', 'коробок')} на схеме</span></div>
        {missingCount > 0 && <p className="storage-placement-warning">Координаты части коробок отсутствуют или не соответствуют количеству. Показаны только известные позиции.</p>}
        {invalidCount > 0 && <p className="storage-placement-warning" role="alert">Обнаружено проблем с геометрией: {invalidCount}. Выход за границы показан за рамкой схемы.</p>}
      </div>}
  </article>
}
export default App
