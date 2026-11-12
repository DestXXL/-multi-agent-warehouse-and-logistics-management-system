import { useState, type FormEvent } from 'react'
import './dispatch.css'

type Metrics = {
  completed: number
  ticks: number
  distance: number
  waiting: number
  queue_wait: number
  requests: number
  tokens: number
  fallbacks: number
}

export type DispatchState = {
  mode: 'rules' | 'model'
  model_available: boolean
  metrics: Metrics
  decisions: {
    role: string
    revision: number
    source: 'model' | 'fallback' | 'rules'
    reason: string
    selected: string[]
    options: Record<string, unknown>
    batches?: Record<string, string[]>
    selected_batch?: string
    tick: number
  }[]
}

type Answer = { answer: string | null; facts: string[]; tick: number }
type Comparison = { rules: Metrics; model: Metrics }

const metrics: [keyof Metrics, string][] = [
  ['completed', 'Выполнено заказов'], ['ticks', 'Такты смены'], ['distance', 'Пройдено клеток'],
  ['waiting', 'Ожидание техники, такты'], ['queue_wait', 'Ожидание заказов, такты'],
  ['requests', 'Запросы к модели'], ['tokens', 'Токены по отчёту провайдера'], ['fallbacks', 'Переходы на правила'],
]
const roles: Record<string, string> = { manager: 'Назначение', zone: 'Проезды', storage: 'Размещение' }
const sources = { model: 'Модель', rules: 'Правила', fallback: 'Резервный алгоритм' }

export default function DispatchPanel({ api, dispatch, disabled, onMode, targets }: {
  api: string
  dispatch: DispatchState
  disabled: boolean
  onMode: (mode: DispatchState['mode']) => void
  targets: string[]
}) {
  const [answer, setAnswer] = useState<Answer>()
  const [comparison, setComparison] = useState<Comparison>()
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')

  async function request<T>(action: string, body?: unknown): Promise<T> {
    const response = await fetch(`${api}/api/dispatch/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Запрос не выполнен.')
    return result
  }

  async function run(action: string, operation: () => Promise<void>) {
    setPending(action)
    setError('')
    try { await operation() }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Нет связи с сервером.') }
    finally { setPending('') }
  }

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const x = String(data.get('x'))
    const y = String(data.get('y'))
    if (Boolean(x) !== Boolean(y)) {
      setError('Укажите обе координаты предполагаемого перекрытия.')
      return
    }
    void run('ask', async () => setAnswer(await request<Answer>('ask', {
      question: data.get('question'), target: data.get('target') || null,
      closure: x && y ? [Number(x), Number(y)] : null,
    })))
  }

  return <div className="dispatch-panel">
    <div className="dispatch-actions">
      <label>Планирование <select value={dispatch.mode} disabled={disabled}
        onChange={event => onMode(event.target.value === 'model' ? 'model' : 'rules')}>
        <option value="rules">Правила</option>
        <option value="model" disabled={!dispatch.model_available}>Модель</option>
      </select></label>
      {!dispatch.model_available && <small>Для режима модели укажите ключ на сервере.</small>}
    </div>
    <h3>Решения</h3>
    {!dispatch.decisions.length && <p>Решения по вариантам появятся после начала смены.</p>}
    {dispatch.decisions.map((decision, index) => <details key={`${decision.role}-${decision.revision}`} open={index === 0}>
      <summary>{roles[decision.role] ?? decision.role} · {sources[decision.source]} · такт {decision.tick}</summary>
      <p>{decision.reason}</p>
      {decision.batches && <ul>{Object.entries(decision.batches).map(([plan, assignments]) => <li key={plan}>
        {plan}{decision.selected_batch === plan ? ' · выбран' : ''} – {assignments.join(', ')}
      </li>)}</ul>}
      <ul>{Object.entries(decision.options).map(([id, option]) => <li key={id}>
        <strong>{id}{decision.selected.includes(id) ? ' · выбран' : ''}</strong>
        <p>{describeOption(option)}</p>
      </li>)}</ul>
    </details>)}
    <h3>Помощник диспетчера</h3>
    <form className="dispatch-form" onSubmit={ask}>
      <label>Вопрос<input name="question" required maxLength={500} placeholder="Почему заказ ждёт?" /></label>
      <label>Заказ или техника <select name="target"><option value="">Весь склад</option>
        {targets.map(id => <option key={id}>{id}</option>)}
      </select></label>
      <div className="dispatch-actions">
        <label>Перекрытие X <input name="x" type="number" min={0} /></label>
        <label>Y <input name="y" type="number" min={0} /></label>
      </div>
      <button className="secondary-button" disabled={disabled || Boolean(pending)}>{pending === 'ask' ? 'Получаем ответ…' : 'Спросить'}</button>
    </form>
    {answer && <div aria-live="polite">
      {answer.answer && <p>{answer.answer}</p>}
      <strong>Данные склада · такт {answer.tick}</strong>
      <ul>{answer.facts.map((fact, index) => <li key={index}>{fact}</li>)}</ul>
    </div>}
    <h3>Сравнение на демосмене</h3>
    <p>Четыре заказа, автоматические подтверждения и одно временное перекрытие в обоих прогонах.</p>
    <button className="secondary-button" disabled={disabled || !dispatch.model_available || Boolean(pending)}
      onClick={() => void run('compare', async () => setComparison(await request<Comparison>('compare')))}>
      {pending === 'compare' ? 'Сравниваем…' : 'Сравнить модель и правила'}
    </button>
    <table>
      <thead><tr><th>Показатель</th><th>Текущая смена</th>{comparison && <><th>Правила</th><th>Модель</th></>}</tr></thead>
      <tbody>{metrics.map(([key, label]) => <tr key={key}><th scope="row">{label}</th>
        <td>{dispatch.metrics[key]}</td>{comparison && <><td>{comparison.rules[key]}</td><td>{comparison.model[key]}</td></>}
      </tr>)}</tbody>
    </table>
    {error && <p className="error-banner" role="alert">{error}</p>}
  </div>
}

function describeOption(value: unknown): string {
  if (Array.isArray(value)) return value.map(row => {
    const evidence = [
      `${row.quantity} шт.`,
      `${row.distance_to_shipping_cells} клеток до отгрузки`,
      `${row.packages_already_stored} шт. уже хранится`,
      `${row.previously_picked_packages} шт. отобрано ранее`,
    ].join(' · ')
    return `${row.address} · ${evidence}`
  }).join('; ')
  const option = value as Record<string, unknown>
  if (typeof option.robot === 'string') {
    const pickups = Object.entries((option.pickups ?? {}) as Record<string, number>)
      .map(([address, count]) => `${address} · ${count} шт.`).join(', ')
    return [option.robot, typeof option.distance === 'number' ? `${option.distance} клеток` : null, pickups].filter(Boolean).join(' · ')
  }
  const route = `${option.passes} · ${option.passage_cells} клеток`
  return option.yields ? `${option.yields} уступает у (${option.wait_cell}) · ${route}` : route
}
