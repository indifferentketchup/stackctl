const TOKEN_KEYS = ['boolab_owner_token', 'access_token', 'jwt']

export function getAuthHeaders(extra = {}) {
  const headers = { ...extra }
  for (const k of TOKEN_KEYS) {
    const v = localStorage.getItem(k)
    if (v) {
      headers.Authorization = `Bearer ${v}`
      break
    }
  }
  return headers
}

export async function apiFetch(path, options = {}) {
  const { headers: userHeaders, ...rest } = options
  const headers = getAuthHeaders(
    userHeaders && typeof userHeaders === 'object' ? userHeaders : {}
  )
  const res = await fetch(path, { ...rest, headers })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const j = await res.json()
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* ignore */
    }
    const err = new Error(detail || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return res.json()
  return res.text()
}
