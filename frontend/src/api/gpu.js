import { apiFetch } from './client.js'

export function getGpuStatus() {
  return apiFetch('/api/gpu/status')
}

export function getGpuConfig() {
  return apiFetch('/api/gpu/config')
}

export function putGpuConfig(key, value) {
  return apiFetch('/api/gpu/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: value ?? '' }),
  })
}

export function markGpuConfigApplied() {
  return apiFetch('/api/gpu/mark-applied', { method: 'POST', headers: {} })
}
