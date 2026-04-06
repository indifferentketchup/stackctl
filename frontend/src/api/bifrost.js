import { apiFetch } from './client.js'

export function getBifrostHealth() {
  return fetch('/api/bifrost/health').then((r) => {
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
  })
}

export function getBifrostConfig() {
  return apiFetch('/api/bifrost/config')
}

export function putBifrostConfig(yamlText) {
  return apiFetch('/api/bifrost/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml_text: yamlText }),
  })
}

export function listBifrostProviders() {
  return apiFetch('/api/bifrost/providers')
}

export function listBifrostModels() {
  return apiFetch('/api/bifrost/models')
}
