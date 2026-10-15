import { useEffect, useMemo, useState } from 'react'

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
  status: 'pending' | 'assigned' | 'picking' | 'delivering' | 'completed'
  robot_id: string | null
  item_id: string | null
  priority: number
}

type InventoryItem = {
  id: string
  name: string
  position: [number, number]
  size: 'small' | 'medium' | 'large'
  status: 'available' | 'reserved' | 'picked' | 'delivered'
  reserved_by: string | null
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
}

const robotNames: Record<Robot['status'], string> = {
  idle: 'Свободен',
  moving: 'В движении',
  waiting: 'Ожидает',
  stopped: 'Остановлен',
}

const stockNames: Record<InventoryItem['status'], string> = {
  available: 'Свободен',
  reserved: 'Зарезервирован',
  picked: 'Забран',
  delivered: 'Доставлен',
}

const sizeNames: Record<InventoryItem['size'], string> = {
  small: 'малый',
  medium: 'средний',
  large: 'крупный',
}

function key([x, y]: [number, number]) {
  return `${x},${y}`
}

function App() {
  const [state, setState] = useState<State | null>(null)
  const [connection, setConnection] = useState<'online' | 'offline'>('offline')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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
  const robots = warehouse?.robots ?? []
  const orders = warehouse?.orders ?? []
  const inventory = warehouse?.inventory ?? []
  const completed = orders.filter((order) => order.status === 'completed').length
  const activeRobots = robots.filter((robot) => robot.status === 'moving').length
  const pending = orders.filter((order) => order.status !== 'completed').length
  const driverRobot = robots.find((robot) => robot.id === driverId) ?? robots[0]
  const driverOrder = orders.find((order) => order.id === driverRobot?.order_id)
  const driverTarget = driverOrder ? (driverRobot?.carrying_item ? driverOrder.dropoff : driverOrder.pickup) : driverRobot?.driver_phase === 'returning' ? driverRobot.home : null

  const cellMap = useMemo(() => {
    const cells = new Map<string, { obstacle?: boolean; closed?: boolean; route?: boolean; pickup?: boolean; shipping?: boolean; robot?: Robot }>()
    warehouse?.obstacles.forEach((point) => cells.set(key(point), { obstacle: true }))
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
      <div title={`Ячейка ${x}, ${y}`} className={`map-cell ${screen === 'driver' && driverTarget && key(driverTarget) === `${x},${y}` ? 'target-cell' : ''} ${cell?.obstacle ? 'shelf-cell' : ''} ${cell?.closed ? 'closed-cell' : ''} ${cell?.route ? 'route-cell' : ''} ${cell?.pickup ? 'pickup-cell' : ''} ${cell?.shipping ? 'shipping-cell' : ''}`} key={`${x}-${y}`}>
        {screen === 'driver' && driverTarget && key(driverTarget) === `${x},${y}` && !cell?.robot && <span className="destination-pin">ЦЕЛЬ</span>}
        {cell?.obstacle && <div className="shelf"><span>▤</span><small>RACK</small></div>}
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

  return (
    <div className="app-shell">
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
              {inventory.map((item) => <div className="inventory-row" key={item.id}><span className={`stock-box ${item.status}`}>▧</span><div className="inventory-info"><strong>{item.name}</strong><span>{item.id} · {sizeNames[item.size]} · ячейка {item.position.join(', ')}</span></div><div className={`stock-status ${item.status}`}>{stockNames[item.status]}{item.reserved_by && item.status === 'reserved' ? ` · ${item.reserved_by}` : ''}</div></div>)}
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
  return <div className="order-row"><div className={`order-symbol ${order.status === 'completed' ? 'done' : ''}`}>{order.status === 'completed' ? '✓' : '↗'}</div><div className="order-main"><strong>{order.id}<span>{order.item}</span></strong><small>{order.robot_id ? `Погрузчик ${order.robot_id}` : 'Ожидает назначения'}</small></div><div className="order-state"><span className={`order-status ${order.status}`}>{orderNames[order.status]}</span><small>{order.pickup.join(', ')} → {order.dropoff.join(', ')}</small></div></div>
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
  const destination = order ? (robot.carrying_item ? order.dropoff : order.pickup) : robot.driver_phase === 'returning' ? robot.home : null
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
        {order && <><div className="task-product"><span className="stock-box">▧</span><div><small>ТОВАР · {order.item_id}</small><strong>{order.item}</strong></div></div>
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

export default App
