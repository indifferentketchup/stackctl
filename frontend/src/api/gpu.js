import { apiFetch, getAuthHeaders } from './client.js'
import { consumeModelsSsePost } from './models.js'

function gpuQuery(machineId) {
  return machineId != null && machineId !== '' ? `?machine_id=${encodeURIComponent(machineId)}` : ''
}

export function getGpuStatus(machineId) {
  return apiFetch(`/api/gpu/status${gpuQuery(machineId)}`)
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

export function fetchNssmEnv(machineId) {
  return apiFetch(`/api/gpu/nssm-env${gpuQuery(machineId)}`)
}

/** @param {Record<string, string>} env */
export function applyNssmEnv(env, onEvent, signal, machineId) {
  return consumeModelsSsePost(`/api/gpu/nssm-env${gpuQuery(machineId)}`, { env }, onEvent, signal)
}

export function restartOllama(onEvent, signal, machineId) {
  return consumeModelsSsePost(`/api/gpu/restart-ollama${gpuQuery(machineId)}`, {}, onEvent, signal)
}

export function stopOllama(onEvent, signal, machineId) {
  return consumeModelsSsePost(`/api/gpu/stop-ollama${gpuQuery(machineId)}`, {}, onEvent, signal)
}

export function startOllama(onEvent, signal, machineId) {
  return consumeModelsSsePost(`/api/gpu/start-ollama${gpuQuery(machineId)}`, {}, onEvent, signal)
}

export function fetchOllamaServiceStatus(machineId) {
  return fetch(`/api/gpu/ollama-service-status${gpuQuery(machineId)}`, {
    headers: getAuthHeaders(),
  }).then((r) => {
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
  })
}
