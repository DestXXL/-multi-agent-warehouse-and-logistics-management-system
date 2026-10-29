import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Rack, Robot, StorageLocation } from './App'
import { findAisleLabels } from './scene-geometry'
import { formatDimensions, formatPercent, occupancyPercent } from './units'

type Point = [number, number]
type Props = {
  warehouse: { width: number; height: number; racks: Rack[]; robots: Robot[]; storage_locations: StorageLocation[]; obstacles: Point[]; closed_cells: Point[]; pickup_points: Point[]; shipping_points: Point[] }
  scale: { cellStepM: number; forkliftLengthM: number; forkliftWidthM: number }
  selectedRack: string | null; selectedRobot: string | null; target?: Point | null
  onRack: (id: string) => void; onRobot: (id: string) => void
}

/** Orthographic floor plan. Every physical length uses the same mm-to-scene ratio. */
export default function WarehouseScene({ warehouse: w, scale, selectedRack, selectedRobot, target, onRack, onRobot }: Props) {
  const id = useId().replace(/:/g, '')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [level, setLevel] = useState(1)
  const [showDimensions, setShowDimensions] = useState(false)
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
  const center = (p: Point) => `${p[0] * unit + 32},${p[1] * unit + 32}`
  function reset() { setZoom(1); setPan({ x: 0, y: 0 }) }
  function zoomBy(amount: number) { setZoom(current => Math.max(1, Math.min(3, current + amount))) }
  return <div className="scene-container">
    <div className="scene-toolbar">
      <span className="scene-view-label">Вид сверху <span>· единый масштаб</span></span>
      <label>Ярус <select value={visibleLevel} onChange={e => setLevel(Number(e.target.value))}>{Array.from({ length: maxLevel }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
      <button type="button" className="scene-dimensions-toggle" aria-pressed={showDimensions} onClick={() => setShowDimensions(value => !value)}>Проезды</button>
      <div className="scene-camera" role="group" aria-label="Масштаб карты">
        <button type="button" aria-label="Уменьшить карту" disabled={zoom <= 1} onClick={() => zoomBy(-0.25)}>−</button>
        <output>{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label="Увеличить карту" disabled={zoom >= 3} onClick={() => zoomBy(0.25)}>+</button>
        <button type="button" aria-label="Показать весь склад" title="Показать весь склад" onClick={reset}>↺</button>
      </div>
    </div>
    <div className="scene-viewport">
      <svg ref={svg} className="warehouse-scene" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Интерактивная карта склада. Стеллажи и погрузчики доступны клавишей Tab." tabIndex={0}
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
          <pattern id={`${id}-grid`} width={unit} height={unit} patternUnits="userSpaceOnUse"><path d={`M ${unit} 0 H 0 V ${unit}`} fill="none" stroke="#263641" strokeWidth="1" /></pattern>
          <pattern id={`${id}-closed`} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="12" fill="#e66d75" fillOpacity=".22" /></pattern>
          <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7898f5" /></marker>
        </defs>
        <g transform={`translate(${32 + pan.x} ${32 + pan.y}) scale(${zoom})`}>
          <rect width={w.width * unit} height={w.height * unit} rx="3" fill="#101a22" stroke="#3a4b58" />
          <rect width={w.width * unit} height={w.height * unit} fill={`url(#${id}-grid)`} />
          {Array.from({ length: w.width }, (_, x) => <text key={x} className="scene-axis" x={x * unit + 32} y="-12" textAnchor="middle">{x}</text>)}
          {Array.from({ length: w.height }, (_, y) => <text key={y} className="scene-axis" x="-14" y={y * unit + 36} textAnchor="middle">{y}</text>)}
          {w.obstacles.filter(p => !w.racks.some(r => r.position[0] === p[0] && r.position[1] === p[1])).map(p => <rect key={`wall-${p}`} x={p[0] * unit + 3} y={p[1] * unit + 3} width="58" height="58" fill="#34434d" />)}
          {(['pickup', 'shipping'] as const).flatMap(kind => w[kind === 'pickup' ? 'pickup_points' : 'shipping_points'].map(p => <g key={`${kind}-${p}`} className={`scene-zone ${kind}`}><rect x={p[0] * unit + 4} y={p[1] * unit + 4} width="56" height="56" rx="4" /><text x={p[0] * unit + 32} y={p[1] * unit + 36} textAnchor="middle">{kind === 'pickup' ? 'Забор' : 'Вывоз'}</text></g>))}
          {target && <g className="scene-target"><rect x={target[0] * unit + 5} y={target[1] * unit + 5} width="54" height="54" rx="4" /><text x={target[0] * unit + 32} y={target[1] * unit + 16} textAnchor="middle">ЦЕЛЬ</text></g>}
          {route && route.route.length > 0 && <polyline className="scene-route" points={[route.position, ...route.route].map(center).join(' ')} markerEnd={`url(#${id}-arrow)`} />}
          {w.racks.map(rack => {
            const rw = rack.width_mm * ratio, rd = rack.depth_mm * ratio
            const x = rack.position[0] * unit + 32 - rw / 2, y = rack.position[1] * unit + 32 - rd / 2
            return <g key={rack.id} role="button" tabIndex={0} aria-label={`Стеллаж ${rack.id}, ${formatDimensions(rack.width_mm, rack.depth_mm, rack.height_mm)}, ${rack.levels} ярусов`} aria-pressed={rack.id === selectedRack} className={`scene-rack ${rack.id === selectedRack ? 'selected' : ''} ${visibleLevel > rack.levels ? 'no-level' : ''}`}
              onMouseEnter={() => setHovered(rack.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(rack.id)} onBlur={() => setHovered(null)} onClick={() => onRack(rack.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRack(rack.id) } }}>
              <rect className="rack-hit-area" x={rack.position[0] * unit + 2} y={rack.position[1] * unit + 2} width={60} height={60} rx="3" />
              <rect className="rack-deck" x={x} y={y} width={rw} height={rd} />
              {(locations.get(rack.id) ?? []).filter(l => l.level === visibleLevel).flatMap(l => l.items.flatMap(item => item.unit_placements.map((box, index) => <rect key={`${l.id}-${item.id}-${index}`} className="scene-package" x={x + (l.x_mm + box.x_mm) * ratio} y={y + (l.y_mm + box.y_mm) * ratio} width={box.length_mm * ratio} height={box.width_mm * ratio}><title>{`${item.name} · ${formatDimensions(box.length_mm, box.width_mm, box.height_mm)}`}</title></rect>)))}
              <path className="rack-frame" d={`M ${x} ${y} H ${x + rw} V ${y + rd} H ${x} Z M ${x + rw / 2} ${y} V ${y + rd}`} />
              <text className="scene-rack-label" style={{ fontSize: labelSize }} x={x + rw / 2} y={y + rd + labelSize} textAnchor="middle">{rack.id}</text>
            </g>
          })}
          {showDimensions && [...aisles].map(([point, aisle]) => {
            const [x, y] = point.split(',').map(Number)
            return <g key={`aisle-${point}`} className={`scene-aisle ${aisle.fitsForklift ? '' : 'too-narrow'}`}><rect x={x * unit + 8} y={y * unit + 22} width="48" height="20" rx="3" /><text x={x * unit + 32} y={y * unit + 36} textAnchor="middle">{aisle.widthM.toLocaleString('ru', { maximumFractionDigits: 1 })} м</text><title>{`Расчётный проезд: ${aisle.widthM.toFixed(1)} м. ${aisle.fitsForklift ? 'Шире корпуса погрузчика' : 'Уже корпуса погрузчика'}. Демо-масштаб, не проверка проходимости.`}</title></g>
          })}
          {w.closed_cells.map(p => <g key={`closed-${p}`}><rect x={p[0] * unit + 2} y={p[1] * unit + 2} width="60" height="60" fill={`url(#${id}-closed)`} stroke="#e66d75" /><text x={p[0] * unit + 32} y={p[1] * unit + 39} textAnchor="middle" fill="#e66d75" fontSize="24">!</text></g>)}
          {w.robots.map(robot => {
            const rw = scale.forkliftWidthM * 1000 * ratio, rh = scale.forkliftLengthM * 1000 * ratio
            const next = robot.route[0]
            const angle = !next ? 0 : next[0] > robot.position[0] ? 90 : next[0] < robot.position[0] ? -90 : next[1] > robot.position[1] ? 180 : 0
            return <g key={robot.id} role="button" tabIndex={0} aria-label={`Погрузчик ${robot.id}, выбрать`} aria-pressed={robot.id === selectedRobot} className={`scene-robot ${robot.status} ${robot.id === selectedRobot ? 'selected' : ''}`} transform={`translate(${robot.position[0] * unit + 32} ${robot.position[1] * unit + 32})`} onClick={() => onRobot(robot.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRobot(robot.id) } }}>
              <circle className="robot-hit-area" r={Math.max(22, rh / 2 + 5)} />
              <g transform={`rotate(${angle})`}><rect className="robot-body" x={-rw / 2} y={-rh / 2} width={rw} height={rh * .75} rx="3" /><rect className="robot-cabin" x={-rw * .32} y={-rh * .22} width={rw * .64} height={rh * .28} rx="2" /><path className="robot-forks" d={`M ${-rw * .3} ${rh * .25} V ${rh / 2} M ${rw * .3} ${rh * .25} V ${rh / 2}`} />{robot.carrying_item && <rect className="scene-package" x={-rw * .4} y={rh * .2} width={rw * .8} height={rh * .3} />}</g>
              <text className="scene-robot-label" y={rh / 2 + 18} textAnchor="middle">{robot.id}</text>
            </g>
          })}
        </g>
      </svg>
      {tip && <div className="scene-tooltip" role="status"><strong>{tip.id} <span>{tip.rack_type_title}</span></strong><p>{formatDimensions(tip.width_mm, tip.depth_mm, tip.height_mm)} · {tip.levels} ярусов</p><p>{formatPercent(occupancyPercent(tip.occupied_locations, tip.location_count))}% мест занято · {tip.free_locations} свободных мест · {tip.service_point ? 'Есть точка обслуживания' : 'Нет точки обслуживания'}</p></div>}
    </div>
    <div className="scene-caption"><span>Перемещайте карту пальцем или мышью. + / − – масштаб</span><span>Грузы: ярус {visibleLevel} · 1 клетка ≈ {scale.cellStepM.toLocaleString('ru')} м</span></div>
  </div>
}
