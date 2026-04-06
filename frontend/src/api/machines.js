import { apiFetch, getAuthHeaders } from './client.js'

async function consumeMachinesSsePost(path, body, onEvent, signal) {
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

export function listMachines() {
  return apiFetch('/api/machines')
}

export function getMachineStatus(machineId, quick = false) {
  const q = quick ? '?quick=true' : ''
  return apiFetch(`/api/machines/${encodeURIComponent(machineId)}/status${q}`)
}

export function fetchMachinesSshStatus() {
  return apiFetch('/api/machines/ssh-status')
}

export function machineSshStream(machineId, command, onEvent, signal) {
  return consumeMachinesSsePost(
    `/api/machines/${encodeURIComponent(machineId)}/ssh`,
    { command },
    onEvent,
    signal
  )
}
