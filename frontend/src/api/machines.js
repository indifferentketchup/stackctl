import { apiFetch, getAuthHeaders } from './client.js'

// CRUD
export function getMachines() {
  return apiFetch('/api/machines')
}

export function getMachineById(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}`)
}

export function createMachine(body) {
  return apiFetch('/api/machines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function updateMachine(id, body) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteMachine(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// Status
export function getMachineHealth(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/health`)
}

export function getMachineStatus(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/status`)
}

export function getMachineSsh(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/ssh`)
}

// Back-compat helper for existing SSH indicators in agent/flow pages.
export async function fetchMachinesSshStatus() {
  const list = await getMachines()
  const machines = list?.machines || []
  const checks = await Promise.all(
    machines.map(async (m) => {
      try {
        const ssh = await getMachineSsh(m.id)
        return { id: m.id, connected: !!ssh?.ok }
      } catch {
        return { id: m.id, connected: false }
      }
    })
  )
  return { machines: checks }
}

// SSH key upload
export function uploadSshKey(formData) {
  return apiFetch('/api/machines/ssh-keys', {
    method: 'POST',
    body: formData,
  })
}

// Framework - generic
export function getFrameworkConfig(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/config`)
}

export function putFrameworkConfig(id, yaml_text) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml_text }),
  })
}

export function getConfigBackups(machineId) {
  return apiFetch(`/api/machines/${encodeURIComponent(machineId)}/framework/config/backups`)
}

export function getConfigBackup(machineId, backupId) {
  return apiFetch(`/api/machines/${encodeURIComponent(machineId)}/framework/config/backups/${encodeURIComponent(backupId)}`)
}

export function restoreConfigBackup(machineId, backupId) {
  return apiFetch(
    `/api/machines/${encodeURIComponent(machineId)}/framework/config/backups/${encodeURIComponent(backupId)}/restore`,
    { method: 'POST' }
  )
}

export function restartFramework(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/restart`, {
    method: 'POST',
  })
}

export function getFrameworkRunning(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/running`)
}

export function warmFramework(id, model) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/warm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
}

export function unloadFramework(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/unload`, {
    method: 'POST',
  })
}

export function getFrameworkModels(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/models`)
}

// Framework - tabbyAPI
export function tabbyLoad(id, model) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/tabby/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
}

export function tabbyUnload(id) {
  return apiFetch(`/api/machines/${encodeURIComponent(id)}/framework/tabby/unload`, {
    method: 'POST',
  })
}

// Framework - Ollama SSE
// Returns a cleanup function. Calls onEvent(data) per SSE event.
export function ollamaCmdSse(id, cmd, args, onEvent, signal) {
  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) {
      abort()
    } else {
      signal.addEventListener('abort', abort, { once: true })
    }
  }

  const cleanup = () => {
    if (signal) signal.removeEventListener('abort', abort)
    ctrl.abort()
  }

  ;(async () => {
    try {
      const res = await fetch(`/api/machines/${encodeURIComponent(id)}/framework/ollama/cmd`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ cmd, args }),
        signal: ctrl.signal,
      })

      if (!res.ok) {
        let msg = res.statusText
        try {
          const text = await res.text()
          if (text) msg = text.slice(0, 500)
        } catch {
          /* ignore */
        }
        throw new Error(msg || `HTTP ${res.status}`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw) continue
          try {
            onEvent(JSON.parse(raw))
          } catch {
            /* ignore malformed event */
          }
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return
      onEvent({ error: err?.message || 'SSE stream failed', done: true })
    } finally {
      if (signal) signal.removeEventListener('abort', abort)
    }
  })()

  return cleanup
}
