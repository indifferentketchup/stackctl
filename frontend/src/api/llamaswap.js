import { apiFetch } from './client.js'

export function getLlamaSwapConfig(machineId) {
  return apiFetch(`/api/llamaswap/${encodeURIComponent(machineId)}/config`)
}

export function putLlamaSwapConfig(machineId, yamlText) {
  return apiFetch(`/api/llamaswap/${encodeURIComponent(machineId)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml_text: yamlText }),
  })
}

export function listLlamaSwapModels(machineId) {
  return apiFetch(`/api/llamaswap/${encodeURIComponent(machineId)}/models`)
}

export function getLlamaSwapRunning(machineId) {
  return apiFetch(`/api/llamaswap/${encodeURIComponent(machineId)}/running`)
}

export function unloadLlamaSwap(machineId) {
  return apiFetch(`/api/llamaswap/${encodeURIComponent(machineId)}/unload`, {
    method: 'POST',
    headers: {},
  })
}

export function restartLlamaSwapService(machineId) {
  return apiFetch(`/api/llamaswap/${encodeURIComponent(machineId)}/restart`, {
    method: 'POST',
    headers: {},
  })
}

export function warmLlamaSwap(machineId, model) {
  return apiFetch(`/api/llamaswap/${encodeURIComponent(machineId)}/warm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
}
