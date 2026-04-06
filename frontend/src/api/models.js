import { fetchMachinesSshStatus } from './machines.js'
import { consumeSsePost } from './ollama.js'

/**
 * Back-compat for agent/flow pages: SSH tools target sam-desktop when present.
 */
export async function fetchSshStatus() {
  const j = await fetchMachinesSshStatus()
  const machines = j.machines || []
  const sd = machines.find((m) => m.id === 'sam-desktop')
  const connected = sd ? !!sd.connected : machines.length === 0 ? true : machines.some((m) => m.connected)
  return { connected, machines, host: '', user: '' }
}

export function pullAndCreateStream(body, onEvent, signal) {
  return consumeSsePost('/api/models/pull-and-create', body, onEvent, signal)
}

export async function consumeModelsSsePost(path, body, onEvent, signal) {
  return consumeSsePost(path, body, onEvent, signal)
}
