import { apiFetch } from './client.js'

export function getBifrostHealth() {
  return fetch('/api/bifrost/health').then((r) => {
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
  })
}

export function listBifrostProviders() {
  return apiFetch('/api/bifrost/providers')
}

export function listBifrostKeys() {
  return apiFetch('/api/bifrost/keys')
}

export function listBifrostModels() {
  return apiFetch('/api/bifrost/models')
}

export function getBifrostMetrics() {
  return apiFetch('/api/bifrost/metrics')
}

export function getBifrostProviderHealth() {
  return apiFetch('/api/bifrost/provider-health')
}

export function createBifrostProvider(body) {
  return apiFetch('/api/bifrost/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteBifrostProvider(name) {
  return apiFetch(`/api/bifrost/providers/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export function addBifrostProviderKey(providerName, key) {
  return apiFetch(`/api/bifrost/providers/${encodeURIComponent(providerName)}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
}

export function deleteBifrostProviderKey(providerName, keyId) {
  return apiFetch(
    `/api/bifrost/providers/${encodeURIComponent(providerName)}/keys/${encodeURIComponent(keyId)}`,
    { method: 'DELETE' }
  )
}
