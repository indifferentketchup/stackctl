import { apiFetch } from './client.js'

export function listMachines() {
  return apiFetch('/api/machines')
}

export function listMachineAssignments() {
  return apiFetch('/api/machines/assignments')
}

export function upsertAssignment(modelName, machineId) {
  return apiFetch('/api/machines/assignments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_name: modelName, machine_id: machineId }),
  })
}

export function deleteAssignment(modelName) {
  return apiFetch(`/api/machines/assignments/${encodeURIComponent(modelName)}`, {
    method: 'DELETE',
    headers: {},
  })
}
