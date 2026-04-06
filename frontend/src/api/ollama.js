import { apiFetch, getAuthHeaders } from './client.js'
import { listBifrostModels } from './bifrost.js'

/**
 * Model list for agent UI — OpenAI-style models from Bifrost.
 * Normalized to `{ models: [{ name, id }] }` like the legacy Ollama list endpoint.
 */
export async function listModels() {
  try {
    const j = await listBifrostModels()
    const data = Array.isArray(j?.data) ? j.data : []
    return {
      models: data.map((x) => ({
        name: x.id || x.model || '',
        id: x.id || x.model || '',
        ...x,
      })),
    }
  } catch {
    return { models: [] }
  }
}

export function getVersion() {
  return apiFetch('/api/bifrost/health').then((h) => ({
    running: h?.ok ? 'Bifrost OK' : '',
    latest: null,
    update_available: false,
  }))
}

/**
 * Consumes SSE from POST endpoints (legacy; kept for any remaining callers).
 */
export async function consumeSsePost(path, body, onEvent, signal) {
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
        if (payload === '[DONE]') return
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
