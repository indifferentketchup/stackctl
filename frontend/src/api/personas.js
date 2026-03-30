import { apiFetch, getAuthHeaders } from './client.js'

/** Same keys as README: ollamactl_boolab_token, plus fallbacks used elsewhere in the app. */
export function getOllamactlToken() {
  return (
    localStorage.getItem('ollamactl_boolab_token') ||
    localStorage.getItem('boolab_owner_token') ||
    localStorage.getItem('access_token') ||
    localStorage.getItem('jwt') ||
    ''
  )
}

function personaAuthHeaders(extra = {}) {
  const h = getAuthHeaders(extra)
  if (!h.Authorization) {
    const t = getOllamactlToken()
    if (t) h.Authorization = `Bearer ${t}`
  }
  return h
}

function authJsonHeaders() {
  return personaAuthHeaders({ 'Content-Type': 'application/json' })
}

export function listPersonas() {
  return apiFetch('/api/personas', { headers: personaAuthHeaders({}) })
}

export function createPersona(body) {
  return apiFetch('/api/personas', {
    method: 'POST',
    headers: authJsonHeaders(),
    body: JSON.stringify(body),
  })
}

export function updatePersona(personaId, body) {
  return apiFetch(`/api/personas/${encodeURIComponent(personaId)}`, {
    method: 'PUT',
    headers: authJsonHeaders(),
    body: JSON.stringify(body),
  })
}

export function deletePersona(personaId) {
  return apiFetch(`/api/personas/${encodeURIComponent(personaId)}`, {
    method: 'DELETE',
    headers: personaAuthHeaders({}),
  })
}

export function setPersonaDefault(personaId, slot) {
  const q = new URLSearchParams({ slot })
  return apiFetch(`/api/personas/${encodeURIComponent(personaId)}/set-default?${q}`, {
    method: 'POST',
    headers: personaAuthHeaders({}),
  })
}

/**
 * Loads the persona icon through ollamactl (authenticated) and returns an object URL. Caller should revoke when done.
 * @param {string} personaId
 */
export async function fetchPersonaIconObjectUrl(personaId) {
  const res = await fetch(`/api/personas/${encodeURIComponent(personaId)}/icon-asset`, {
    headers: personaAuthHeaders({}),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const j = await res.json()
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`)
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

export async function uploadPersonaIcon(personaId, file) {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`/api/personas/${encodeURIComponent(personaId)}/icon`, {
    method: 'POST',
    headers: personaAuthHeaders({}),
    body: fd,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const j = await res.json()
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`)
  }
  return res.json()
}
