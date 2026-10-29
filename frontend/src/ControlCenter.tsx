import { useEffect, useRef, useState } from 'react'
import type { Rack, Robot, Order } from './App'
import { formatDimensions, formatSquareMillimeters, occupancyPercent } from './units'

export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('warehouse-theme') === 'light' ? 'light' : 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('warehouse-theme', theme)
  }, [theme])
  const isLight = theme === 'light'
  return <button className="theme-toggle" type="button" role="switch" aria-checked={isLight} aria-label={isLight ? 'Светлая тема' : 'Тёмная тема'} onClick={() => setTheme(isLight ? 'dark' : 'light')}>
    <span className="theme-toggle-icon" aria-hidden="true">☾</span><span className="theme-toggle-track"><i /></span><span className="theme-toggle-icon" aria-hidden="true">☼</span>
  </button>
}

export function Navigation({ screen, onChange }: { screen: 'control' | 'driver' | 'layout'; onChange: (screen: 'control' | 'driver') => void }) {
  return <nav className="app-navigation" aria-label="Основная навигация">
    <div className="nav-brand" aria-hidden="true">W<span>CC</span></div>
    <button type="button" className={screen === 'control' ? 'active' : ''} aria-current={screen === 'control' ? 'page' : undefined} onClick={() => onChange('control')}><NavIcon kind="map" /><span>Диспетчерская</span></button>
    <button type="button" className={screen === 'driver' ? 'active' : ''} aria-current={screen === 'driver' ? 'page' : undefined} onClick={() => onChange('driver')}><NavIcon kind="tablet" /><span>Планшет водителя</span></button>
    <a href="?view=layout" className={screen === 'layout' ? 'active' : ''} aria-current={screen === 'layout' ? 'page' : undefined}><NavIcon kind="layout" /><span>Конструктор</span></a>
    <div className="nav-footer">Модель склада<span>Локальная симуляция</span></div>
  </nav>
}

function NavIcon({ kind }: { kind: 'map' | 'tablet' | 'layout' }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{kind === 'map' ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 8h4v5H7zM15 8h2M15 12h2" /></> : kind === 'tablet' ? <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M9 6h6M11 18h2" /></> : <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>}</svg>
}

export function ObjectInspector({ rack, robot, order, phase, status, isOpen, onClose, onRackDetails }: { rack?: Rack; robot?: Robot; order?: Order; phase?: string; status?: string; isOpen: boolean; onClose: () => void; onRackDetails: () => void }) {
  const panel = useRef<HTMLElement>(null)
  const selection = rack?.id ?? robot?.id ?? order?.id
  useEffect(() => {
    if (selection) panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selection])
  return <section ref={panel} className={`panel object-inspector ${(rack || robot || order) ? 'has-selection' : ''}`} role={isOpen && selection ? 'dialog' : undefined} aria-modal={isOpen && selection ? true : undefined} aria-hidden={!isOpen} aria-label="Выбранный объект">
    <div className="inspector-heading"><div><span className="inspector-type">{rack ? 'Стеллаж' : robot ? 'Погрузчик' : order ? 'Заказ' : 'Контекст объекта'}</span><h2>{rack?.id ?? robot?.id ?? order?.id ?? 'Выберите объект'}</h2></div>{(rack || robot || order) && <button className="icon-button" aria-label="Закрыть окно объекта" onClick={onClose}>×</button>}</div>
    {rack ? <>
      <div className="rack-elevation" role="img" aria-label={`Фасад стеллажа: ${rack.levels} ярусов, ${formatDimensions(rack.width_mm, rack.depth_mm, rack.height_mm)}`}>
        <svg viewBox={`0 0 ${rack.width_mm + 120} ${rack.height_mm + 120}`} preserveAspectRatio="xMidYMid meet">
          <rect x="40" y="40" width={rack.width_mm} height={rack.height_mm} fill="#1b2933" stroke="#7895a4" strokeWidth="40" />
          {Array.from({ length: rack.levels }, (_, i) => <g key={i}><path d={`M 40 ${40 + (i + 1) * rack.height_mm / rack.levels} h ${rack.width_mm}`} stroke="#7895a4" strokeWidth="30" /></g>)}
        </svg>
        <span>{rack.rack_type_title}</span>
      </div>
      <dl className="inspector-specs"><dt>Габариты</dt><dd>{formatDimensions(rack.width_mm, rack.depth_mm, rack.height_mm)}</dd><dt>Ярусы / места</dt><dd>{rack.levels} / {rack.location_count}</dd><dt>Коробок</dt><dd>{rack.package_count}</dd><dt>Площадь свободных полок</dt><dd>{formatSquareMillimeters(rack.free_surface_mm2)}</dd><dt>Точка обслуживания (клетка)</dt><dd>{rack.service_point ? rack.service_point.join(' · ') : 'Нет точки'}</dd></dl>
      <div className="inspector-occupancy"><span>Занято мест <b>{rack.occupied_locations} / {rack.location_count}</b></span><progress max="100" value={occupancyPercent(rack.occupied_locations, rack.location_count)} /></div>
      <button className="primary-button" onClick={onRackDetails}>Содержимое по ярусам ↗</button>
    </> : robot ? <>
      <div className={`inspector-status ${robot.status}`}>{phase}</div>
      <dl className="inspector-specs"><dt>Позиция</dt><dd>{robot.position.join(' · ')}</dd><dt>Задание</dt><dd>{robot.order_id ?? 'Нет задания'}</dd><dt>Осталось клеток</dt><dd>{robot.route.length}</dd><dt>Версия маршрута</dt><dd>{robot.route_version}</dd><dt>Груз</dt><dd>{robot.carrying_item ? 'На борту' : 'Пусто'}</dd></dl>
      {robot.route.length > 0 && <p className="inspector-note">Маршрут выделен на карте. Цель: {robot.route[robot.route.length - 1].join(' · ')}.</p>}
      <a className="primary-button" href={`?view=driver&vehicle=${encodeURIComponent(robot.id)}`}>Открыть планшет водителя ↗</a>
    </> : order ? <>
      <span className={`order-status ${order.status}`}>{status}</span><h3>{order.item}</h3>
      <dl className="inspector-specs"><dt>Количество</dt><dd>{order.quantity} шт.</dd><dt>Погрузчик</dt><dd>{order.robot_id ?? 'Не назначен'}</dd><dt>Приоритет</dt><dd>{order.priority}</dd><dt>Забор (клетка)</dt><dd>{order.pickup.join(' · ')}</dd><dt>Отгрузка (клетка)</dt><dd>{order.dropoff.join(' · ')}</dd><dt>Габариты коробки</dt><dd>{order.length_mm && order.width_mm && order.height_mm ? formatDimensions(order.length_mm, order.width_mm, order.height_mm) : 'Не указаны'}</dd></dl>
      <p className="inspector-note">{order.allocations.length ? order.allocations.map(a => `${a.storage_location_id}: ${a.quantity} шт. · ${a.picked ? 'забрано' : 'к отбору'}`).join('\n') : 'Адреса отбора появятся после назначения.'}</p>
    </> : <div className="inspector-empty"><NavIcon kind="map" /><p>Выберите стеллаж или погрузчик на карте, чтобы увидеть характеристики и доступные действия.</p><span>Состояние поступает из симуляции</span></div>}
  </section>
}
