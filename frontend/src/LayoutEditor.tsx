import { useEffect, useState } from 'react'
import './layout.css'
type Kind = 'rack' | 'wall' | 'pickup' | 'shipping' | 'robot'
type Cell = { x: number; y: number; kind: Kind; levels: number }
type Layout = { version: 1; width: number; height: number; cells: Cell[] }
const labels: Record<Kind, string> = { rack: 'Стеллаж', wall: 'Стена', pickup: 'Забор', shipping: 'Отгрузка', robot: 'Стоянка' }
const api = `http://${window.location.hostname}:8000`
export default function LayoutEditor() {
  const [layout, setLayout] = useState<Layout | null>(null)
  const [tool, setTool] = useState<Kind | 'erase'>('rack')
  const [levels, setLevels] = useState(3)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function request(path: string, method = 'GET', body?: unknown) {
    const r = await fetch(api + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await r.json()
    if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Некорректный формат макета. Проверьте размеры, типы объектов и ярусы.')
    return data
  }
  useEffect(() => { request('/api/layout').then(setLayout).catch(e => setMessage(String(e))) }, [])
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
  const capacity = layout.cells.filter(c => c.kind === 'rack').reduce((s,c) => s+c.levels,0)
  return <main className="layout-editor">
    <header><div><small>WAREHOUSE / ПОДГОТОВКА СРЕДЫ</small><h1>Конструктор склада</h1><p>Разместите объекты кликом. Свободные клетки — проходы; повторный клик обновляет объект.</p></div><a href="?view=control">← Диспетчерская</a></header>
    <div className="layout-columns"><aside>
      <h2>Размеры в клетках</h2>
      {(['width', 'height'] as const).map((axis) => <label key={axis}>{axis === 'width' ? 'Ширина' : 'Высота'}<input type="number" min="4" max={axis === 'width' ? 40 : 30} value={layout[axis]} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 4 && n <= (axis === 'width' ? 40 : 30)) setLayout({ ...layout, [axis]: n }) }} /></label>)}
      <p>При уменьшении объекты за границей сохраняются: удалите их или верните размер. Проверка укажет ошибку.</p>
      <h2>Объекты</h2><div className="layout-tools">{(Object.keys(labels) as Kind[]).map(k => <button className={tool === k ? 'selected' : ''} key={k} onClick={() => setTool(k)}>{labels[k]}</button>)}<button className={tool === 'erase' ? 'selected' : ''} onClick={() => setTool('erase')}>Ластик / проход</button></div>
      <label>Ярусов в стеллаже<input type="number" min="1" max="12" value={levels} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 12) setLevels(n) }} /></label>
      <p>Ярусы описывают места хранения. Движение техники остаётся на уровне пола.</p>
      <button disabled={busy} onClick={() => run(async () => { const r = await request('/api/layout/validate', 'POST', layout); setMessage(r.valid ? 'Макет корректен: объекты доступны через проходы.' : r.errors.join('; ')) })}>Проверить</button>
      <button disabled={busy} onClick={() => run(async () => { await request('/api/layout', 'PUT', layout); setMessage('Макет применён. В диспетчерской добавьте заказ и запустите симуляцию.') })}>Применить к симуляции</button>
      <button disabled={busy} onClick={() => run(async () => { const state = await request('/api/state'); const w = state.warehouse; await request('/api/orders', 'POST', {item:'Демонстрационный груз',pickup:w.pickup_points[0],dropoff:w.shipping_points[0]}); setMessage('Заказ добавлен на применённый склад. Откройте диспетчерскую и запустите симуляцию.') })}>Добавить демозаказ на склад</button>
      <p>Применение создаёт пустую смену на новом складе. Доступно до запуска заданий; после запуска нужен сброс в диспетчерской.</p>
      <button onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(layout,null,2)], {type:'application/json'})); const a = document.createElement('a'); a.href=url; a.download='warehouse-layout.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000) }}>Скачать JSON</button>
      <label>Загрузить JSON<input disabled={busy} type="file" accept=".json,application/json" onChange={e => { const file=e.target.files?.[0]; if(file) void load(file); e.target.value='' }} /></label>
    </aside><section><div className="layout-summary">{layout.width} × {layout.height} · {layout.cells.filter(c=>c.kind==='rack').length} стеллажей · {capacity} мест по ярусам</div>
      <div className="layout-grid-scroll"><div className="layout-grid" style={{ gridTemplateColumns: `repeat(${layout.width}, 42px)` }}>{Array.from({length:layout.width*layout.height},(_,i) => { const x=i%layout.width, y=Math.floor(i/layout.width), c=cells.get(`${x},${y}`); return <button key={i} className={`layout-cell ${c?.kind || ''}`} title={`(${x}, ${y}) ${c ? labels[c.kind] : 'Проход'}`} aria-label={`(${x}, ${y}) ${c ? labels[c.kind] : 'Проход'}`} onClick={() => { setLayout({...layout,cells:[...layout.cells.filter(c=>c.x!==x || c.y!==y),...(tool==='erase' ? [] : [{x,y,kind:tool,levels:tool==='rack'?levels:1}])]}); setMessage('Есть изменения. Проверьте и примените макет.') }}>{c ? c.kind==='rack' ? `${c.levels} яр.` : {wall:'■',pickup:'З',shipping:'О',robot:'Р'}[c.kind] : <small>{x},{y}</small>}</button> })}</div></div>
      <p role="status" className="layout-message">{message || 'З — забор · О — отгрузка · Р — стоянка. Координаты начинаются с нуля.'}</p>
      <p>Менеджер назначает задания, агент робота строит маршрут, агент зоны учитывает блокировки. Конструктор передаёт геометрию обычному серверному валидатору.</p>
    </section></div>
  </main>
}
