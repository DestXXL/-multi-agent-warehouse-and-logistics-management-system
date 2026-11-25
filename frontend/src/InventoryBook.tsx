import { useState } from 'react'

export type Movement = { time: string; sku: string; address: string; before: number; after: number; operation: string; note: string }
type Row = { item: {id: string; name: string; quantity: number}; address: string }
type Analysis = {answer: string | null; facts: string[]; source: string; tick: number; error?: string}

export default function InventoryBook<T extends {stock_movements?: Movement[]} >({rows, movements, api, online, refresh}: {
  rows: Row[]; movements: Movement[]; api: string; online: boolean; refresh: (state: T) => void
}) {
  const [selected, setSelected] = useState<Row | null>(null)
  const [operation, setOperation] = useState('receipt')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  async function analyze() {
    setAnalyzing(true); setAnalysis(null); setFeedback('')
    try {
      const r = await fetch(api+'/api/dispatch/ask', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({target:'inventory',question:'По данным о свободном остатке и ожидающих заказах поясни, каких товаров не хватает, и предложи диспетчеру порядок проверки. Не прогнозируй будущий спрос.'})})
      if (!r.ok) throw Error()
      setAnalysis(await r.json())
    } catch {setFeedback('Не удалось получить анализ запасов.')}
    finally {setAnalyzing(false)}
  }
  return <div className="inventory-book">
    <details><summary>Оформить движение или пересчёт</summary>
      <form onSubmit={async e=>{
        e.preventDefault(); if (!selected || busy) return
        const form=e.currentTarget; const data=new FormData(form)
        setBusy(true); setFeedback('')
        try {
          const r=await fetch(api+'/api/inventory/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item_id:selected.item.id, operation, amount:Number(data.get('amount')), expected:selected.item.quantity,note:data.get('note')})})
          if(!r.ok){const result=await r.json();throw Error(typeof result.detail==='string'?result.detail:'Проверьте поля операции.')}
          const state=await r.json()
          setSelected(null); form.reset(); setAnalysis(null); refresh(state)
          const row=state.stock_movements[0] as Movement
          setFeedback(row.operation+' · '+row.before+' → '+row.after+' шт.')
        } catch(e){setFeedback(e instanceof Error?e.message:'Не удалось провести операцию.')}
        finally{setBusy(false)}
      }}>
        <label>Товар и адрес<select required value={selected?.item.id ?? ''} onChange={e=>setSelected(rows.find(r=>r.item.id===e.target.value) ?? null)}><option value="">Выберите позицию</option>{rows.map(r=><option key={r.item.id} value={r.item.id}>{r.item.name} · {r.address} · {r.item.quantity} шт.</option>)}</select></label>
        <label>Операция<select value={operation} onChange={e=>setOperation(e.target.value)}><option value="receipt">Приход</option><option value="expense">Списание</option><option value="count">Инвентаризация</option></select></label>
        <label>{operation==='count'?'Фактически насчитано, шт.':'Количество, шт.'}<input name="amount" type="number" required min={operation==='count'?0:1} max={10000}/></label>
        <label>Основание<input name="note" required maxLength={160} placeholder="Накладная, брак или результат пересчёта"/></label>
        <button disabled={!online || busy || !selected}>Провести</button>
      </form>
    </details>
    <details><summary>Последние движения ({movements.length})</summary>{movements.length ? movements.map((m,i)=><p key={i}><b>{m.operation} · {m.sku}</b> · {m.address}<br/>{m.before} → {m.after} шт. · {m.note} · {new Date(m.time).toLocaleTimeString('ru')}</p>) : <p>Движений пока нет.</p>}</details>
    <button disabled={analyzing || !online} onClick={analyze}>{analyzing?'Анализируем…':'Проверить дефицит по заказам'}</button>
    {analysis && <section><strong>{analysis.source==='model' && analysis.answer?'Комментарий ИИ':analysis.source==='demo'?'Демонстрационный анализ':'Расчёт по остаткам'} · такт {analysis.tick}</strong>{analysis.answer && <p>{analysis.answer}</p>}{analysis.error && <p>Комментарий модели недоступен.</p>}<ul>{analysis.facts.map(f=><li key={f}>{f}</li>)}</ul></section>}
    {feedback && <p role="status">{feedback}</p>}
  </div>
}
