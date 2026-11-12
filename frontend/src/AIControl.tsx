import { useState, type FormEvent } from 'react'

export type AIState = {
  provider: string; model: string; models: string[]; configured: boolean; connection: string
  requests: number; tokens: number; unknown_usage: number; errors: number; last_error: string | null
  last_latency_ms: number | null; inflight: boolean; cooldown_seconds: number; budget_exhausted: boolean
  settings: { model: string; max_tokens: number; timeout: number; request_limit: number; token_limit: number; temperature: number | null; json_mode: boolean }
  tools: Record<string, { name: string; description: string }>
  history: { id: string; time: string; role: string; scope: string; source: string; trigger: string; status: string; outcome: string; response: unknown; error: string | null; latency_ms: number | null; tokens: number | null }[]
}

const names: Record<string, string> = { manager: 'Менеджер', zone: 'Координатор проездов', storage: 'Размещение', robot: 'Консультант по технике', operator: 'Помощник диспетчера' }
const connections: Record<string, string> = { unconfigured: 'Ключ не задан на сервере', unverified: 'Подключение ещё не проверено', connected: 'Получен корректный ответ', error: 'Ошибка подключения или ответа' }

export default function AIControl({ api, ai, disabled, mode, agents }: {
  api: string; ai: AIState; disabled: boolean; mode: string
  agents: { id: string; task: string | null; status: string; llm: boolean }[]
}) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [detail, setDetail] = useState<{ id: string; text: string }>()

  async function action(path: string, method = 'POST', body?: unknown) {
    setPending(true); setMessage('')
    try {
      const response = await fetch(`${api}/api/dispatch/${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Проверьте значения настроек')
      if (path === 'test') setMessage(result.ok ? 'Модель ответила. Проверка записана в журнал.' : result.state.last_error || 'Запрос пропущен: действует лимит, пауза после ошибки или другой запрос.')
      else if (path.startsWith('history/')) setDetail({ id: path.slice(8), text: JSON.stringify(result, null, 2) })
      else setMessage('Настройки применены к следующим запросам. После перезапуска используются серверные значения.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Нет связи с сервером') }
    finally { setPending(false) }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    void action('settings', 'PUT', { model: values.get('model'), max_tokens: Number(values.get('max_tokens')),
      timeout: Number(values.get('timeout')), request_limit: Number(values.get('request_limit')),
      token_limit: Number(values.get('token_limit')), temperature: values.get('temperature') === '' ? null : Number(values.get('temperature')),
      json_mode: values.get('json_mode') === 'on' })
  }

  return <>
    <section className="ai-overview" aria-label="Состояние искусственного интеллекта">
      <div><strong>{ai.provider}</strong><p>{ai.model}</p></div>
      <p className="ai-status">{ai.inflight ? 'Агент ожидает ответ…' : connections[ai.connection]}</p>
      {mode === 'demo' && <p className="ai-notice">Демонстрация без LLM. Решения выбирает программа; платных запросов нет.</p>}
      {mode === 'rules' && <p>Работают алгоритмы. Автоматические запросы к LLM отключены.</p>}
      <div className="ai-stats">
        <div><strong>{ai.requests} / {ai.settings.request_limit}</strong><span>запросы за запуск сервера</span></div>
        <div><strong>{ai.tokens}</strong><span>токены по ответам провайдера</span></div>
        <div><strong>{ai.errors}</strong><span>ошибки запросов</span></div>
        <div><strong>{ai.last_latency_ms === null ? 'Нет данных' : `${ai.last_latency_ms} мс`}</strong><span>последний ответ</span></div>
      </div>
      {ai.unknown_usage > 0 && <p>В {ai.unknown_usage} ответах провайдер не сообщил расход. Лимит запросов продолжает действовать.</p>}
      {ai.budget_exhausted && <p role="status">Лимит исчерпан. Назначения продолжатся по правилам. Можно увеличить лимит в настройках.</p>}
      {ai.last_error && <p role="status">{ai.last_error}{ai.cooldown_seconds > 0 ? ` · пауза ${ai.cooldown_seconds} с` : ''}</p>}
    </section>
    <details>
      <summary>Подключение и настройки</summary>
      <p>Ключ и адрес API задаются на сервере. Инструкция: docs/LLM.md. Проверка подключения отправит один запрос и может расходовать токены.</p>
      <form className="dispatch-form" onSubmit={save} key={JSON.stringify(ai.settings)}>
        <label>Модель<select name="model" defaultValue={ai.settings.model}>{ai.models.map(model => <option key={model}>{model}</option>)}</select></label>
        <details><summary>Параметры и лимиты</summary><div className="ai-fields">
          <label>Максимум токенов ответа<input name="max_tokens" type="number" min={100} max={4096} defaultValue={ai.settings.max_tokens} required /></label>
          <label>Ожидание, секунды<input name="timeout" type="number" min={1} max={60} step="0.5" defaultValue={ai.settings.timeout} required /></label>
          <label>Лимит запросов<input name="request_limit" type="number" min={1} max={1000} defaultValue={ai.settings.request_limit} required /></label>
          <label>Бюджет токенов<input name="token_limit" type="number" min={4096} max={1000000} defaultValue={ai.settings.token_limit} required /></label>
          <label>Temperature, если поддерживается<input name="temperature" type="number" min={0} max={2} step="0.1" defaultValue={ai.settings.temperature ?? ''} /></label>
          <label><input name="json_mode" type="checkbox" defaultChecked={ai.settings.json_mode} /> Передавать формат JSON в API</label>
        </div></details>
        <button className="secondary-button" disabled={disabled || pending || ai.inflight}>Применить настройки</button>
      </form>
      <button className="secondary-button" disabled={disabled || pending || ai.inflight || !ai.configured || ai.budget_exhausted || ai.cooldown_seconds > 0} onClick={() => void action('test')}>Проверить подключение</button>
    </details>
    {message && <p role="status">{message}</p>}
    <h3>Агенты и инструменты</h3>
    <div className="ai-agent-list">{Object.entries(ai.tools).map(([role, tool]) => {
      const last = ai.history.find(row => row.role === role)
      return <article key={role}><strong>{names[role]}</strong><p>{tool.description}</p><small>{last ? `${last.source === 'demo' ? 'Демонстрация' : 'LLM'} · ${last.outcome}` : mode === 'rules' ? 'Выбор выполняют правила; консультант возвращает факты' : 'Ожидает события или вопроса'}</small></article>
    })}{agents.map(agent => <article key={agent.id}><strong>{agent.id} · алгоритм</strong><p>{agent.task || 'Без задания'} · {agent.status}</p><small>Маршрут, движение и подтверждения контролирует симуляция.</small></article>)}</div>
    <h3>История обращений</h3>
    <p>Хранятся последние 100 обращений в памяти сервера. Ответ модели является предложением; результат проверки показан отдельно.</p>
    {!ai.history.length && <p>Выберите демонстрацию и запустите смену или задайте вопрос помощнику.</p>}
    <div className="ai-history">{ai.history.map(row => <details key={row.id}>
      <summary>{new Date(row.time).toLocaleTimeString()} · {names[row.role]} · {row.source === 'demo' ? 'Демонстрация' : 'LLM'}</summary>
      <p>{row.scope} · {row.trigger}</p><p><strong>{row.outcome}</strong></p>
      {row.response != null && <pre className="ai-json">{JSON.stringify(row.response, null, 2)}</pre>}
      {row.error && <p>{row.error}</p>}
      <small>{row.latency_ms ?? '…'} мс · {row.tokens === null ? 'Расход токенов не указан' : `${row.tokens} токенов`}</small>
      <button className="secondary-button" disabled={pending} onClick={() => void action(`history/${row.id}`, 'GET')}>Контекст и результат</button>
      {detail?.id === row.id && <pre className="ai-json">{detail.text}</pre>}
    </details>)}</div>
  </>
}
