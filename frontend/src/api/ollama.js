import { apiFetch, getAuthHeaders } from './client.js'

export function listModels() {
  return apiFetch('/api/ollama/models')
}

export function getRunning() {
  return apiFetch('/api/ollama/running')
}

export function getVersion() {
  return apiFetch('/api/ollama/version')
}

export function showModel(name) {
  const q = new URLSearchParams({ name })
  return apiFetch(`/api/ollama/show?${q}`)
}

export function deleteModel(name) {
  return apiFetch(`/api/ollama/models/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: {},
  })
}

export function unloadAll() {
  return apiFetch('/api/ollama/unload-all', { method: 'POST', headers: {} })
}

export function unloadModel(name) {
  return apiFetch(`/api/ollama/unload/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {},
  })
}

export function copyModel(source, destination) {
  return apiFetch('/api/ollama/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, destination }),
  })
}

/**
 * Consumes SSE from POST endpoints (pull, create).
 * @param {string} path
 * @param {object} body
 * @param {(obj: object) => void} onEvent
 * @param {AbortSignal} [signal]
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

export function pullModelStream(model, onEvent, signal) {
  return consumeSsePost('/api/ollama/pull', { model }, onEvent, signal)
}

export function createModelStream(name, modelfile, onEvent, signal) {
  return consumeSsePost('/api/ollama/create', { name, modelfile }, onEvent, signal)
}
