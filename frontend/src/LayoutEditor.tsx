import { Navigation, ThemeToggle } from './ControlCenter'
import { useEffect, useRef, useState } from 'react'
import './layout.css'
import { meterInputValue, millimetersFromMeters } from './units'
type Kind = 'rack' | 'wall' | 'pickup' | 'shipping' | 'robot'
type RackType = { key: string; title: string; purpose: string; width_mm: number; depth_mm: number; height_mm: number; levels: number; positions_per_level: number }
type Cell = { x: number; y: number; kind: Kind; levels: number; id?: string; rack_type?: string; width_mm?: number; depth_mm?: number; height_mm?: number; positions_per_level?: number }
type Layout = { version: 1; width: number; height: number; cells: Cell[] }
const labels: Record<Kind, string> = { rack: 'Стеллаж', wall: 'Стена', pickup: 'Забор', shipping: 'Отгрузка', robot: 'Стоянка' }
const api = `http://${window.location.hostname}:8000`
export default function LayoutEditor() {
  const [layout, setLayout] = useState<Layout | null>(null)
  const [tool, setTool] = useState<Kind | 'erase'>('rack')
  const [rackType, setRackType] = useState('pallet_high')
  const [rackTypes, setRackTypes] = useState<Record<string, RackType>>({})
  const [selectedRack, setSelectedRack] = useState<string | null>(null)
  const settings = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (selectedRack && settings.current) {
      settings.current.open = true
      settings.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [selectedRack])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [fit, setFit] = useState(false)
  const [cellSize, setCellSize] = useState(44)
  async function request(path: string, method = 'GET', body?: unknown) {
    const r = await fetch(api + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await r.json()
    if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Некорректный формат макета. Проверьте размеры, типы объектов и ярусы.')
    return data
  }
  useEffect(() => { Promise.all([request('/api/layout'), request('/api/rack-types')]).then(([nextLayout, types]) => { setLayout(nextLayout); setRackTypes(types) }).catch(e => setMessage(String(e))) }, [])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    try { await action() } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function load(file: File) {
    await run(async () => {
      if (file.size > 250000) throw new Error('Файл слишком большой (максимум 250 КБ)')
      const candidate = JSON.parse(await file.text())
      const result = await request('/api/layout/validate', 'POST', candidate)
      if (!result.valid) throw new Error(result.errors.join('; '))
      setLayout(candidate); setMessage('Макет загружен в редактор. Нажмите «Применить», чтобы передать его симуляции.')
    })
  }
  if (!layout) return <main className="layout-editor"><a href="?view=control">← Диспетчерская</a><p role="status">{message || 'Загрузка макета…'}</p></main>
  const cells = new Map(layout.cells.map(c => [`${c.x},${c.y}`, c]))
  const selected = selectedRack ? cells.get(selectedRack) : undefined
  const updateRack = (field: 'id' | 'rack_type' | 'width_mm' | 'depth_mm' | 'height_mm' | 'levels' | 'positions_per_level', value: string | number) => {
    if (!selected || selected.kind !== 'rack') return
    setLayout({ ...layout, cells: layout.cells.map(cell => cell === selected ? { ...cell, [field]: value } : cell) })
    setMessage('Есть изменения. Проверьте и примените макет.')
  }
  const capacity = layout.cells.filter(c => c.kind === 'rack').reduce((s,c) => s+c.levels*(c.positions_per_level || 2),0)
  return <div className="app-shell"><Navigation screen="layout" onChange={screen => { window.location.search = `?view=${screen}` }} /><main className="layout-editor">
    <header><div><small>ПОДГОТОВКА СКЛАДА</small><h1>Конструктор склада</h1><p>Разместите объекты кликом. Свободные клетки – проходы; нажатие на стеллаж открывает его настройки.</p></div><div className="layout-header-actions"><ThemeToggle /><a href="?view=control">← Диспетчерская</a></div></header>
    <div className="layout-columns"><aside><details ref={settings} className="editor-settings"><summary>Настройки склада и объектов</summary>
      <h2>Размеры в клетках</h2>
      {(['width', 'height'] as const).map((axis) => <label key={axis}>{axis === 'width' ? 'Ширина' : 'Высота'}<input type="number" min="4" max={axis === 'width' ? 40 : 30} value={layout[axis]} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 4 && n <= (axis === 'width' ? 40 : 30)) setLayout({ ...layout, [axis]: n }) }} /></label>)}
      <p>При уменьшении объекты за границей сохраняются: удалите их или верните размер. Проверка укажет ошибку.</p>
      <h2>Объекты</h2><div className="layout-tools">{(Object.keys(labels) as Kind[]).map(k => <button className={tool === k ? 'selected' : ''} key={k} onClick={() => setTool(k)}>{labels[k]}</button>)}<button className={tool === 'erase' ? 'selected' : ''} onClick={() => setTool('erase')}>Ластик / проход</button></div>
      {tool === 'rack' && <label>Тип нового стеллажа<select value={rackType} onChange={e => setRackType(e.target.value)}>{Object.values(rackTypes).map(type => <option key={type.key} value={type.key}>{type.title}</option>)}</select></label>}
      {tool === 'rack' && <label>Мест на ярусе<input type="number" min="1" max="100" value={rackTypes[rackType]?.positions_per_level || 2} onChange={e => { const n=Number(e.target.value); if(Number.isInteger(n)&&n>=1&&n<=100) setRackTypes({...rackTypes,[rackType]:{...rackTypes[rackType],positions_per_level:n}}) }} /></label>}
      {selected?.kind === 'rack' && <div className="rack-fields"><h2>Стеллаж {selected.id || selectedRack}</h2><label>ID<input value={selected.id || ''} onChange={e => updateRack('id', e.target.value)} /></label><label>Тип<select value={selected.rack_type || ''} onChange={e => updateRack('rack_type', e.target.value)}>{Object.values(rackTypes).map(type => <option key={type.key} value={type.key}>{type.title}</option>)}</select></label>{([['width_mm', 'Ширина, м'], ['depth_mm', 'Глубина, м'], ['height_mm', 'Высота, м']] as const).map(([field, label]) => <label key={field}>{label}<input type="number" min="0.001" step="0.001" value={meterInputValue(selected[field] ?? 0)} onChange={e => updateRack(field, millimetersFromMeters(Number(e.target.value)))} /></label>)}<label>Ярусов<input type="number" min="1" max="12" value={selected.levels} onChange={e => updateRack('levels', Number(e.target.value))} /></label><label>Мест на ярусе<input type="number" min="1" max="100" value={selected.positions_per_level || 2} onChange={e => updateRack('positions_per_level', Number(e.target.value))} /></label><p>Смена типа не перезаписывает индивидуальные размеры стеллажа.</p></div>}
      <p>Ярусы описывают места хранения. Движение техники остаётся на уровне пола.</p>
      </details><div className="editor-actions"><button disabled={busy} onClick={() => run(async () => { const r = await request('/api/layout/validate', 'POST', layout); setMessage(r.valid ? 'Макет корректен: объекты доступны через проходы.' : r.errors.join('; ')) })}>Проверить</button>
      <button disabled={busy} onClick={() => run(async () => { await request('/api/layout', 'PUT', layout); setMessage('Макет применён. В диспетчерской добавьте заказ и запустите симуляцию.') })}>Применить к симуляции</button></div><details className="editor-settings"><summary>Импорт, экспорт и демозаказ</summary>
      <button disabled={busy} onClick={() => run(async () => { const state = await request('/api/state'); const w = state.warehouse; await request('/api/orders', 'POST', {item:'Демонстрационный груз',pickup:w.pickup_points[0],dropoff:w.shipping_points[0]}); setMessage('Заказ добавлен на применённый склад. Откройте диспетчерскую и запустите симуляцию.') })}>Добавить демозаказ на склад</button>
      <p>Применение создаёт пустую смену на новом складе. Доступно до запуска заданий; после запуска нужен сброс в диспетчерской.</p>
      <button onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(layout,null,2)], {type:'application/json'})); const a = document.createElement('a'); a.href=url; a.download='warehouse-layout.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000) }}>Скачать JSON</button>
      <label>Загрузить JSON<input disabled={busy} type="file" accept=".json,application/json" onChange={e => { const file=e.target.files?.[0]; if(file) void load(file); e.target.value='' }} /></label>
    </details></aside><section><div className="layout-summary">{layout.width} × {layout.height} клеток · {layout.cells.filter(c=>c.kind==='rack').length} стеллажей · {capacity} мест по ярусам</div>
      <div className="editor-camera"><button onClick={() => { setFit(false); setCellSize(n => Math.max(32, n - 8)) }} aria-label="Уменьшить сетку">−</button><button onClick={() => { setFit(false); setCellSize(n => Math.min(88, n + 8)) }} aria-label="Увеличить сетку">+</button><button aria-pressed={fit} onClick={() => setFit(v => !v)}>{fit ? 'Рабочий масштаб' : 'Показать весь склад'}</button><span>Прокрутите сетку в любом направлении. Стеллаж: ярусы × места.</span></div><div className="layout-grid-scroll"><div className={`layout-grid ${fit ? 'fit-grid' : ''}`} style={{ gridTemplateColumns: `repeat(${layout.width}, ${fit ? 'minmax(0, 1fr)' : `${cellSize}px`})` }}>{Array.from({length:layout.width*layout.height},(_,i) => { const x=i%layout.width, y=Math.floor(i/layout.width), c=cells.get(`${x},${y}`); return <button key={i} style={{ width: fit ? '100%' : cellSize, height: fit ? 'auto' : cellSize, aspectRatio: '1' }} className={`layout-cell ${c?.kind || ''}`} title={`(${x}, ${y}) ${c ? labels[c.kind] : 'Проход'}`} aria-label={`(${x}, ${y}) ${c ? labels[c.kind] : 'Проход'}`} onClick={() => { if (tool === 'rack' && c?.kind === 'rack') { setSelectedRack(`${x},${y}`); return } const template=rackTypes[rackType]; setLayout({...layout,cells:[...layout.cells.filter(c=>c.x!==x || c.y!==y),...(tool==='erase' ? [] : [{x,y,kind:tool,levels:tool==='rack'?template?.levels || 5:1,...(tool==='rack' ? {id:`A-${String(y+1).padStart(2,'0')}${String(x+1).padStart(2,'0')}`,rack_type:rackType,width_mm:template?.width_mm||2700,depth_mm:template?.depth_mm||1100,height_mm:template?.height_mm||6000,positions_per_level:template?.positions_per_level||2} : {})}])]}); setSelectedRack(tool === 'rack' ? `${x},${y}` : null); setMessage('Есть изменения. Проверьте и примените макет.') }}>{c ? c.kind==='rack' ? `${c.levels} × ${c.positions_per_level || 2}` : {wall:'■',pickup:'З',shipping:'О',robot:'Р'}[c.kind] : <small>{x},{y}</small>}</button> })}</div></div>
      <p role="status" className="layout-message">{message || 'З – забор · О – отгрузка · Р – стоянка. Координаты начинаются с нуля.'}</p>
      <p>Менеджер назначает задания, агент робота строит маршрут, агент зоны учитывает блокировки. Перед применением проверьте доступность объектов.</p>
    </section></div>
  </main></div>
}
