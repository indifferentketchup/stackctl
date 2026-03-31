import { getAuthHeaders } from './client.js'

export function fetchSshStatus() {
  return fetch('/api/models/ssh-status').then((r) => {
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
  })
}

/**
 * SSE from /api/models/apply and /api/models/pull-and-create (typed events).
 * @param {string} path
 * @param {object} body
 * @param {(obj: { type: string, line?: string, message?: string, success?: boolean }) => void} onEvent
 * @param {AbortSignal} [signal]
 */
export async function consumeModelsSsePost(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const t = await res.text()
      if (t) msg = t.slice(0, 500)
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const block of parts) {
      const lines = block.split('\n').filter(Boolean)
      for (const line of lines) {
        const m = line.match(/^data:\s*(.*)$/)
        if (!m) continue
        const payload = m[1].trim()
        if (!payload) continue
        try {
          onEvent(JSON.parse(payload))
        } catch {
          /* ignore */
        }
      }
    }
  }
}
