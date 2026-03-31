import { apiFetch } from './client.js'
import { consumeModelsSsePost } from './models.js'

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

export function fetchNssmEnv() {
  return apiFetch('/api/gpu/nssm-env')
}

/** @param {Record<string, string>} env */
export function applyNssmEnv(env, onEvent, signal) {
  return consumeModelsSsePost('/api/gpu/nssm-env', { env }, onEvent, signal)
}

export function restartOllama(onEvent, signal) {
  return consumeModelsSsePost('/api/gpu/restart-ollama', {}, onEvent, signal)
}

export function stopOllama(onEvent, signal) {
  return consumeModelsSsePost('/api/gpu/stop-ollama', {}, onEvent, signal)
}

export function startOllama(onEvent, signal) {
  return consumeModelsSsePost('/api/gpu/start-ollama', {}, onEvent, signal)
}

export function fetchOllamaServiceStatus() {
  return fetch('/api/gpu/ollama-service-status').then((r) => {
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
  })
}
