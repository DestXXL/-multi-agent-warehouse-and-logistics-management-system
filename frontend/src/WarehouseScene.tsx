import { floorMarkings } from './service-aisles'
import TrafficMarkings, { type Lane } from './TrafficMarkings'
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Order, Rack, Robot, StorageLocation } from './App'
import { findAisleLabels } from './scene-geometry'
import { formatDimensions, formatPercent, occupancyPercent, NODE_SPACING_M } from './units'

type Point = [number, number]
type Props = {
  running: boolean; simulationSpeed: number
  warehouse: { node_spacing_m?: number; roads?: { edges: [Point, Point][]; stops: Point[] }; lanes?: Lane[]; width: number; height: number; orders: Order[]; racks: Rack[]; robots: Robot[]; storage_locations: StorageLocation[]; obstacles: Point[]; closed_cells: Point[]; pickup_points: Point[]; shipping_points: Point[] }
  scale: { cellStepM: number; forkliftLengthM: number; forkliftWidthM: number }
  selectedRack: string | null; selectedRobot: string | null; target?: Point | null
  onRack: (id: string) => void; onRobot: (id: string) => void
}

/** Orthographic floor plan. Every physical length uses the same mm-to-scene ratio. */
export default function WarehouseScene({ warehouse: w, scale, selectedRack, selectedRobot, target, onRack, onRobot, running, simulationSpeed }: Props) {
  const id = useId().replace(/:/g, '')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [level, setLevel] = useState(1)
  const [showLanes, setShowLanes] = useState(true)
  const [showAccess, setShowAccess] = useState(false)
  const access = useMemo(() => floorMarkings(w), [w])
  const [showRoutes, setShowRoutes] = useState(true)
  const spacing = w.node_spacing_m ?? NODE_SPACING_M
  const [showDimensions, setShowDimensions] = useState(false)
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const resizeDrag = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const aisles = useMemo(() => findAisleLabels(w, scale.cellStepM, scale.forkliftWidthM), [w.racks, w.obstacles, scale.cellStepM, scale.forkliftWidthM])
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const unit = 64
  const ratio = unit / (scale.cellStepM * 1000)
  const width = w.width * unit + 64, height = w.height * unit + 64
  const [labelSize, setLabelSize] = useState(16)
  useEffect(() => {
    const node = svg.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      const box = node.getBoundingClientRect()
      const ratio = Math.min(box.width / width, box.height / height)
      setLabelSize(Math.min(25, Math.max(14, 11 / Math.max(.1, ratio))))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [width, height])
  const locations = useMemo(() => {
    const result = new Map<string, StorageLocation[]>()
    w.storage_locations.forEach(location => result.set(location.rack_id, [...(result.get(location.rack_id) ?? []), location]))
    return result
  }, [w.storage_locations])
  const maxLevel = Math.max(1, ...w.racks.map(r => r.levels))
  const visibleLevel = Math.min(level, maxLevel)
  const tip = w.racks.find(r => r.id === hovered)
  const route = w.robots.find(r => r.id === selectedRobot)
  const job = w.orders.find(o => o.id === route?.order_id)
  const picking = route && ['offered', 'to_pickup', 'confirm_pickup'].includes(route.driver_phase)
  const focusRack = picking ? job?.storage_location_id?.split('-L')[0] : undefined
  const gateIndex = job ? w.shipping_points.findIndex(p => p[0] === job.dropoff[0] && p[1] === job.dropoff[1]) : -1
  const nextStop = focusRack ? `Стеллаж ${focusRack}` : job && gateIndex >= 0 ? `Ворота ${gateIndex + 1}` : route?.driver_phase === 'returning' ? 'Стоянка' : ''
  const center = (p: Point) => `${p[0] * unit + 32},${p[1] * unit + 32}`
  function reset() { setZoom(1); setPan({ x: 0, y: 0 }) }
  function zoomBy(amount: number) { setZoom(current => Math.max(1, Math.min(3, current + amount))) }
  const beginViewportResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (!bounds) return
    resizeDrag.current = { x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveViewportResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!resizeDrag.current) return
    const maxWidth = Math.max(280, viewportRef.current?.parentElement?.clientWidth ?? window.innerWidth)
    const maxHeight = Math.max(320, Math.min(window.innerHeight - 150, 1200))
    setViewportSize({
      width: Math.max(280, Math.min(maxWidth, resizeDrag.current.width + event.clientX - resizeDrag.current.x)),
      height: Math.max(320, Math.min(maxHeight, resizeDrag.current.height + event.clientY - resizeDrag.current.y)),
    })
  }
  const endViewportResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    resizeDrag.current = null
  }
  return <div className="scene-container">
    <div className="scene-toolbar">
      <span className="floor-map-key">{nextStop ? <><i />{route?.id} → {nextStop}</> : 'План склада'}</span>
      <details className="floor-layers"><summary>Слои карты</summary><div>
        <label>Ярус <select value={visibleLevel} onChange={e => setLevel(Number(e.target.value))}>{Array.from({ length: maxLevel }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
        <label><input type="checkbox" checked={showRoutes} onChange={e => setShowRoutes(e.target.checked)} />Маршруты</label>
        {!!w.lanes?.length && <label><input type="checkbox" checked={showLanes} onChange={e => setShowLanes(e.target.checked)} />Направления проездов</label>}
        <label><input type="checkbox" checked={showAccess} onChange={e => setShowAccess(e.target.checked)} />Места отбора</label>
        <label><input type="checkbox" checked={showDimensions} onChange={e => setShowDimensions(e.target.checked)} />Размеры и координаты</label>
      </div></details>
      <div className="scene-camera" role="group" aria-label="Масштаб карты">
        <button type="button" aria-label="Уменьшить карту" disabled={zoom <= 1} onClick={() => zoomBy(-0.25)}>−</button>
        <output>{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label="Увеличить карту" disabled={zoom >= 3} onClick={() => zoomBy(0.25)}>+</button>
        <button type="button" aria-label="Показать весь склад" title="Показать весь склад" onClick={reset}>↺</button>
      </div>
    </div>
    <div ref={viewportRef} className="scene-viewport" style={viewportSize ? { width: `${viewportSize.width}px`, height: `${viewportSize.height}px` } : undefined}>
      <svg ref={svg} className="warehouse-scene floor-plan" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Интерактивная карта склада. Стеллажи и погрузчики доступны клавишей Tab." tabIndex={0}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          if (event.key === '+' || event.key === '=') zoomBy(0.25)
          else if (event.key === '-') zoomBy(-0.25)
          else if (event.key === '0' || event.key === 'Escape') reset()
          else if (event.key.startsWith('Arrow')) { event.preventDefault(); setPan(p => ({ x: p.x + (event.key === 'ArrowLeft' ? 32 : event.key === 'ArrowRight' ? -32 : 0), y: p.y + (event.key === 'ArrowUp' ? 32 : event.key === 'ArrowDown' ? -32 : 0) })) }
        }}
        onPointerDown={event => {
          if ((event.target as Element).closest('[role="button"]')) return
          const matrix = svg.current?.getScreenCTM()
          if (!matrix) return
          drag.current = { x: event.clientX / matrix.a, y: event.clientY / matrix.d, px: pan.x, py: pan.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => { const matrix = svg.current?.getScreenCTM(); if (drag.current && matrix) setPan({ x: drag.current.px + event.clientX / matrix.a - drag.current.x, y: drag.current.py + event.clientY / matrix.d - drag.current.y }) }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        <defs>
          <pattern id={`${id}-slab`} width={unit * 2} height={unit * 2} patternUnits="userSpaceOnUse">
            <rect width={unit * 2} height={unit * 2} fill="var(--map-floor)" />
            <path d={`M0 ${unit * 2}V0H${unit * 2}`} fill="none" stroke="var(--map-border)" strokeOpacity=".28" strokeWidth="1.4" />
          </pattern>
          <pattern id={`${id}-closed`} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="12" fill="#e66d75" fillOpacity=".22" /></pattern>
          <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--route)" /></marker>
        </defs>
        <g transform={`translate(${32 + pan.x} ${32 + pan.y}) scale(${zoom})`}>
          <rect width={w.width * unit} height={w.height * unit} rx="3" fill={`url(#${id}-slab)`} stroke="var(--map-border)" />
          {showDimensions && Array.from({ length: Math.ceil(w.width * scale.cellStepM / 5) }, (_, i) => <text key={i} className="scene-axis" x={i * 5 * unit / scale.cellStepM} y="-12" textAnchor="middle">{i * 5} м</text>)}
          {showDimensions && Array.from({ length: Math.ceil(w.height * scale.cellStepM / 5) }, (_, i) => <text key={i} className="scene-axis" x="-14" y={i * 5 * unit / scale.cellStepM + 4} textAnchor="middle">{i * 5}</text>)}
          <g transform={`scale(${unit})`} pointerEvents="none" aria-label="Промышленная разметка пола">
            <path d={access.storage} fill="var(--map-rack)" opacity=".3" />
            <path d={access.perimeter} fill="none" stroke="var(--accent)" strokeWidth=".022" opacity=".52" />
            {access.road && <path d={access.road} fill="none" stroke="var(--muted)" strokeWidth=".62" opacity=".12" strokeLinecap="round" />}
            {showAccess && access.stops.map(([x,y]) => <path key={x+','+y} d={`M${x+.37} ${y+.5}h.26`} stroke="var(--muted)" strokeWidth=".045" />)}
            {w.robots.map(robot => <rect key={robot.id} x={robot.home[0]+.1} y={robot.home[1]+.1} width=".8" height=".8" rx=".04" fill="none" stroke="var(--vehicle)" strokeWidth=".028" strokeDasharray=".18 .09"><title>Стоянка {robot.id}</title></rect>)}
          </g>
          {showLanes && w.lanes && <TrafficMarkings lanes={w.lanes} unit={unit} />}
          {w.obstacles.filter(p => !w.racks.some(r => r.position[0] === p[0] && r.position[1] === p[1])).map(p => <rect key={`wall-${p}`} x={p[0] * unit + 3} y={p[1] * unit + 3} width="58" height="58" fill="var(--map-wall)" />)}
          {w.shipping_points.map(([x,y], index) => <g key={`shipping-${x},${y}`} className={`dock-mark ${job && !picking && gateIndex === index ? 'is-target' : ''}`} transform={`translate(${(x+.5)*unit} ${(y+.5)*unit})`}>
            <rect x="-28" y="-26" width="56" height="52" rx="5" />
            <path d="M-12 -3v-12h24v12 M-8 -11H8 M-8 -7H8" />
            <text y="14" textAnchor="middle">Ворота {index+1}</text>
            <title>Ворота отгрузки {index+1}</title>
          </g>)}
          {target && <g className="scene-target"><rect x={target[0] * unit + 5} y={target[1] * unit + 5} width="54" height="54" rx="4" /><text x={target[0] * unit + 32} y={target[1] * unit + 16} textAnchor="middle">Цель</text></g>}
          {showRoutes && w.robots.filter(r => r.route.length && (!route || r.id === route.id)).map(r => {
            const start = r.position_m ? r.position_m.map(n => n * unit / spacing).join(',') : center(r.position)
            return <polyline key={r.id} className="scene-route" opacity={route ? 1 : .7} points={[start, ...r.route.map(center)].join(' ')} markerEnd={`url(#${id}-arrow)`}><title>Маршрут {r.id}</title></polyline>
          })}
          {w.racks.map(rack => {
            const rw = rack.width_mm * ratio, rd = rack.depth_mm * ratio
            const x = rack.position[0] * unit + 32 - rw / 2, y = rack.position[1] * unit + 32 - rd / 2
            return <g key={rack.id} role="button" tabIndex={0} aria-label={`Стеллаж ${rack.id}, ${formatDimensions(rack.width_mm, rack.depth_mm, rack.height_mm)}, ${rack.levels} ярусов`} aria-pressed={rack.id === selectedRack} className={`scene-rack ${rack.id === focusRack ? 'work-rack' : ''} ${rack.id === selectedRack ? 'selected' : ''} ${visibleLevel > rack.levels ? 'no-level' : ''}`}
              onMouseEnter={() => setHovered(rack.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(rack.id)} onBlur={() => setHovered(null)} onClick={() => onRack(rack.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRack(rack.id) } }}>
              <rect className="rack-hit-area" x={rack.position[0] * unit + 2} y={rack.position[1] * unit + 2} width={60} height={60} rx="3" />
              {rack.id === focusRack && <rect className="target-bay" x={rack.position[0]*unit+2} y={rack.position[1]*unit+2} width={unit-4} height={unit-4} rx="5" />}
              <rect className="rack-deck" x={x} y={y} width={rw} height={rd} />
              {(locations.get(rack.id) ?? []).filter(l => l.level === visibleLevel).flatMap(l => l.items.flatMap(item => item.unit_placements.map((box, index) => <rect key={`${l.id}-${item.id}-${index}`} className={`scene-package ${w.robots.some(robot => robot.driver_phase === 'confirm_pickup' && robot.pickup_location_id === l.id && robot.pickup_product_id === item.id) ? 'package-picking' : ''}`} x={x + (l.x_mm + box.x_mm) * ratio} y={y + (l.y_mm + box.y_mm) * ratio} width={box.length_mm * ratio} height={box.width_mm * ratio}><title>{`${item.name} · ${formatDimensions(box.length_mm, box.width_mm, box.height_mm)}`}</title></rect>)))}
              <path className="rack-frame" d={`M ${x} ${y} H ${x + rw} V ${y + rd} H ${x} Z M ${x + rw / 2} ${y} V ${y + rd}`} />
              <path className="rack-end-panels" d={`M ${x} ${y} V ${y + rd} M ${x + rw} ${y} V ${y + rd}`} />
              <path className="rack-beams" d={`M${x} ${y+1}h${rw} M${x} ${y+rd-1}h${rw}`} />
              <text className="scene-rack-label" style={{ fontSize: labelSize }} x={x + rw / 2} y={y + rd + labelSize} textAnchor="middle">{rack.id}</text>
            </g>
          })}
          {showDimensions && [...aisles].map(([point, aisle]) => {
            const [x, y] = point.split(',').map(Number)
            return <g key={`aisle-${point}`} className={`scene-aisle ${aisle.fitsForklift ? '' : 'too-narrow'}`}><rect x={x * unit + 8} y={y * unit + 22} width="48" height="20" rx="3" /><text x={x * unit + 32} y={y * unit + 36} textAnchor="middle">{aisle.widthM.toLocaleString('ru', { maximumFractionDigits: 1 })} м</text><title>{`Расчётный проезд: ${aisle.widthM.toFixed(1)} м. ${aisle.fitsForklift ? 'Шире корпуса погрузчика' : 'Уже корпуса погрузчика'}. Демо-масштаб, не проверка проходимости.`}</title></g>
          })}
          {w.closed_cells.map(p => <g key={`closed-${p}`}><rect x={p[0] * unit + 2} y={p[1] * unit + 2} width="60" height="60" fill={`url(#${id}-closed)`} stroke="#e66d75" /><text x={p[0] * unit + 32} y={p[1] * unit + 39} textAnchor="middle" fill="#e66d75" fontSize="24">!</text></g>)}
          {w.robots.map(robot => <Forklift key={robot.id} robot={robot} unit={unit} spacing={spacing} speed={simulationSpeed} running={running} rw={scale.forkliftWidthM * 1000 * ratio} rh={scale.forkliftLengthM * 1000 * ratio} selected={robot.id === selectedRobot} onSelect={() => onRobot(robot.id)} />)}
        </g>
      </svg>
      <button type="button" className="scene-resize-handle" aria-label="Изменить размер карты" title="Потяните, чтобы изменить размер карты" onPointerDown={beginViewportResize} onPointerMove={moveViewportResize} onPointerUp={endViewportResize} onPointerCancel={endViewportResize}><span aria-hidden="true">◢</span></button>

    </div>
    <div className="scene-speedometer" aria-label="Скорость выбранного погрузчика">
      {tip ? <span className="floor-object-hint"><strong>{tip.id}</strong> · {tip.rack_type_title} · {formatPercent(occupancyPercent(tip.occupied_locations, tip.location_count))}% мест занято</span> : <>
      <small>{route ? `Погрузчик ${route.id}` : 'Скорость погрузчика'}</small>
      <strong>{route ? (running && route.motion === 'moving' && !route.stopped_by_operator ? '5,4' : '0') : '–'} <span>км/ч</span></strong>
      <small>{!route ? 'Выберите погрузчик на карте' : !running ? 'На паузе' : route.stopped_by_operator ? 'Остановлен оператором' : route.motion === 'moving' ? 'Движение · 1,5 м/с' : route.motion === 'turning' ? 'Поворот на месте' : 'Стоит'} · ×{simulationSpeed}</small>
      </>}
    </div>
    {showDimensions && <div className="scene-caption"><span>{showLanes && w.lanes?.length ? 'Стрелка – направление потока · сплошная – граница встречных полос' : 'Перетащите карту · + / − для масштаба'}</span><span>{showAccess && 'Штрих у полки – место отбора · '}Контур – зона хранения · Грузы: ярус {visibleLevel} · координаты от верхнего левого угла, м</span></div>}
  </div>
}


function Forklift({ robot, unit, spacing, speed, running, rw, rh, selected, onSelect }: { speed: number; running: boolean; robot: Robot; unit: number; spacing: number; rw: number; rh: number; selected: boolean; onSelect: () => void }) {
  const body = useRef<SVGGElement>(null)
  const orientation = useRef<SVGGElement>(null)
  const x = (robot.position_m ? robot.position_m[0] / spacing : robot.position[0] + 0.5) * unit
  const y = (robot.position_m ? robot.position_m[1] / spacing : robot.position[1] + 0.5) * unit
  const angle = robot.heading + 90
  const pose = useRef({ x, y, angle })
  useLayoutEffect(() => {
    const start = pose.current
    const turn = ((angle - start.angle) % 360 + 540) % 360 - 180
    const paint = (fraction: number) => {
      const current = { x: start.x + (x - start.x) * fraction, y: start.y + (y - start.y) * fraction, angle: start.angle + turn * fraction }
      pose.current = current
      body.current?.setAttribute('transform', `translate(${current.x} ${current.y})`)
      orientation.current?.setAttribute('transform', `rotate(${current.angle})`)
    }
    const distance = Math.hypot(x - start.x, y - start.y)
    if (!running || robot.stopped_by_operator || (!distance && !turn) || distance > unit * 1.1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(1)
      return
    }
    // Keep animation local to this SVG group; the warehouse can contain thousands of storage locations.
    const duration = 1000 / speed
    const began = performance.now()
    let frame: number
    function draw(now: number) {
      const progress = Math.min(1, Math.max(0, (now - began) / duration))
      paint(progress)
      if (progress < 1) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [x, y, angle, unit, speed, running, robot.stopped_by_operator])
  return <g role="button" tabIndex={0} aria-label={`Погрузчик ${robot.id}, выбрать`} aria-pressed={selected} data-robot={robot.id} data-heading={robot.heading} data-motion={robot.motion} className={`scene-robot ${robot.status} ${selected ? 'selected' : ''} ${robot.driver_phase === 'confirm_pickup' ? 'picking' : ''}`} ref={body} onClick={onSelect} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}>
    <circle className="robot-hit-area" r={Math.max(22, rh / 2 + 5)} />
    <g className="robot-orientation" ref={orientation}>
      <rect className="robot-body" x={-rw / 2} y={-rh * .12} width={rw} height={rh * .62} rx="3" />
      <rect className="robot-cabin" x={-rw * .32} y={rh * .08} width={rw * .64} height={rh * .25} rx="2" />
      <g className="robot-loader"><path className="robot-forks" d={`M ${-rw * .48} ${-rh * .12} H ${rw * .48} M ${-rw * .32} ${-rh * .12} V ${-rh * .5} M ${rw * .32} ${-rh * .12} V ${-rh * .5}`} />
      {robot.carrying_item && <rect className="scene-package robot-cargo" x={-rw * .42} y={-rh * .46} width={rw * .84} height={rh * .3} />}</g>
    </g>
    <text className="scene-robot-label" y={rh / 2 + 18} textAnchor="middle">{robot.id}</text>
  </g>
}
