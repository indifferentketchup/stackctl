import { apiFetch, getAuthHeaders } from './client.js'

export function listModels(machineId) {
  const q = machineId != null && machineId !== '' ? `?machine_id=${encodeURIComponent(machineId)}` : ''
  return apiFetch(`/api/ollama/models${q}`)
}

export function getRunning(machineId) {
  const q = machineId != null && machineId !== '' ? `?machine_id=${encodeURIComponent(machineId)}` : ''
  return apiFetch(`/api/ollama/running${q}`)
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

/** Validate path on sam-desktop over SSH. */
export function verifySamPath(path) {
  return apiFetch('/api/ollama/verify-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
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

/**
 * Create with optional quantize (q8_0 | q4_K_S | q4_K_M). Omit quantize for normal create.
 */
export function createQuantizedModelStream(name, modelfile, quantize, onEvent, signal) {
  const body = { name, modelfile }
  if (quantize) body.quantize = quantize
  return consumeSsePost('/api/ollama/create-quantized', body, onEvent, signal)
}

/** HuggingFace repo file list; returns `{ error }` on 404 without throwing. */
export async function fetchHfRepoFiles(repo) {
  const q = new URLSearchParams({ repo })
  const res = await fetch(`/api/ollama/hf-files?${q}`, { headers: getAuthHeaders() })
  let data = {}
  try {
    data = await res.json()
  } catch {
    data = {}
  }
  if (res.status === 404 && data?.error) return data
  if (!res.ok) {
    const msg =
      typeof data?.detail === 'string' ? data.detail : data?.error || res.statusText || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}
