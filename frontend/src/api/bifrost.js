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
