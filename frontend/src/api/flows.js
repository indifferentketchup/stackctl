import { apiFetch, getAuthHeaders } from './client.js'

export function listFlows() {
  return apiFetch('/api/flows')
}

export function getFlow(id) {
  return apiFetch(`/api/flows/${encodeURIComponent(id)}`)
}

export function createFlow(body) {
  return apiFetch('/api/flows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function updateFlow(id, body) {
  return apiFetch(`/api/flows/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteFlow(id) {
  return apiFetch(`/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE', headers: {} })
}

export function listFlowRuns(flowId) {
  return apiFetch(`/api/flows/${encodeURIComponent(flowId)}/runs`)
}

export function getFlowRun(flowId, runId) {
  return apiFetch(`/api/flows/${encodeURIComponent(flowId)}/runs/${encodeURIComponent(runId)}`)
}

export async function runFlowSse(flowId, input, onEvent, signal) {
  const res = await fetch(`/api/flows/${encodeURIComponent(flowId)}/run`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ input: input || '' }),
    signal,
  })
  if (!res.ok) throw new Error(await res.text().then((t) => t.slice(0, 400) || res.statusText))
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No body')
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const block of parts) {
      for (const line of block.split('\n').filter(Boolean)) {
        const m = line.match(/^data:\s*(.*)$/)
        if (!m) continue
        const p = m[1].trim()
        if (!p) continue
        try {
          onEvent(JSON.parse(p))
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export async function exportFlowN8n(flowId, body = {}) {
  const res = await fetch(`/api/flows/${encodeURIComponent(flowId)}/export-n8n`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      ollamactl_url: body.ollamactlUrl || window.location.origin,
      ollama_url: body.ollamaUrl || '',
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
