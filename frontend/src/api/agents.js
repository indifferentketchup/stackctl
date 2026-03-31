import { apiFetch, getAuthHeaders } from './client.js'

export function listAgents() {
  return apiFetch('/api/agents')
}

export function getAgent(id) {
  return apiFetch(`/api/agents/${encodeURIComponent(id)}`)
}

export function createAgent(body) {
  return apiFetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function updateAgent(id, body) {
  return apiFetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteAgent(id) {
  return apiFetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE', headers: {} })
}

export function listAgentRuns(agentId) {
  return apiFetch(`/api/agents/${encodeURIComponent(agentId)}/runs`)
}

export function deleteAgentRun(agentId, runId) {
  return apiFetch(`/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
    headers: {},
  })
}

export async function runAgentSse(agentId, body, onEvent, signal) {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/run`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
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

export async function exportAgentN8n(agentId, ollamactlUrl = '') {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/export-n8n`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ollamactl_url: ollamactlUrl || window.location.origin }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export function exportAgentDaw(agentId) {
  return apiFetch(`/api/agents/${encodeURIComponent(agentId)}/export-daw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}
