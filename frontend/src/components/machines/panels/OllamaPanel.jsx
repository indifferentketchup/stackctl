import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { getFrameworkRunning, ollamaCmdSse, restartFramework } from '@/api/machines.js'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Input } from '@/components/ui/input.jsx'

const COMMANDS = [
  { key: 'pull', label: 'Pull', needsModel: true },
  { key: 'rm', label: 'Remove', needsModel: true },
  { key: 'list', label: 'List', needsModel: false },
  { key: 'show', label: 'Show', needsModel: true },
  { key: 'stop', label: 'Stop', needsModel: true },
  { key: 'start', label: 'Start', needsModel: true },
]

function runningRows(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.models)) return payload.models
    if (Array.isArray(payload.running)) return payload.running
  }
  return []
}

function rowName(row) {
  if (typeof row === 'string') return row
  if (!row || typeof row !== 'object') return 'unknown'
  return row.name || row.model || row.id || row.model_id || 'unknown'
}

export function OllamaPanel({ machineId }) {
  const qc = useQueryClient()
  const [activeCmd, setActiveCmd] = useState(null)
  const [argInput, setArgInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [output, setOutput] = useState('Ready.')
  const cleanupRef = useRef(null)
  const outputRef = useRef(null)

  const qRunning = useQuery({
    queryKey: ['framework-running', machineId],
    queryFn: () => getFrameworkRunning(machineId),
    enabled: !!machineId,
    refetchInterval: 15_000,
  })
  const restartMut = useMutation({
    mutationFn: () => restartFramework(machineId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
    },
  })

  const rows = useMemo(() => runningRows(qRunning.data?.raw), [qRunning.data?.raw])

  useEffect(() => {
    if (!outputRef.current) return
    outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [output])

  useEffect(() => {
    return () => {
      if (cleanupRef.current) cleanupRef.current()
    }
  }, [])

  const runCommand = (cmd, args = '') => {
    if (cleanupRef.current) cleanupRef.current()
    setOutput(`$ ollama ${cmd}${args ? ` ${args}` : ''}\n`)
    setIsStreaming(true)
    cleanupRef.current = ollamaCmdSse(
      machineId,
      cmd,
      args,
      (event) => {
        if (event?.line) {
          setOutput((prev) => `${prev}${event.line}\n`)
        }
        if (event?.error) {
          setOutput((prev) => `${prev}ERROR: ${event.error}\n`)
        }
        if (event?.done) {
          setIsStreaming(false)
          cleanupRef.current = null
          qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
          const tail = event?.exit_code != null ? `\n(exit ${event.exit_code})` : '\n(done)'
          setOutput((prev) => `${prev}${tail}\n`)
        }
      },
      undefined
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Running models</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {qRunning.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading running models...
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No running models.</p>
          ) : (
            rows.map((row, idx) => (
              <div key={`${rowName(row)}-${idx}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <p className="font-mono text-xs">{rowName(row)}</p>
              </div>
            ))
          )}
          {qRunning.isError ? <p className="text-sm text-destructive">{qRunning.error?.message}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Command panel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {COMMANDS.map((c) => (
              <Button
                key={c.key}
                variant="outline"
                disabled={isStreaming}
                onClick={() => {
                  if (!c.needsModel) return runCommand(c.key)
                  setActiveCmd(c.key)
                  setArgInput('')
                }}
              >
                {c.label}
              </Button>
            ))}
          </div>

          {activeCmd ? (
            <div className="flex items-center gap-2">
              <Input
                placeholder="Model name"
                value={argInput}
                onChange={(e) => setArgInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && argInput.trim()) {
                    runCommand(activeCmd, argInput.trim())
                    setActiveCmd(null)
                  }
                }}
              />
              <Button
                size="sm"
                onClick={() => {
                  if (!argInput.trim()) return
                  runCommand(activeCmd, argInput.trim())
                  setActiveCmd(null)
                }}
              >
                Run
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setActiveCmd(null)}>
                Cancel
              </Button>
            </div>
          ) : null}

          <pre ref={outputRef} className="max-h-64 overflow-y-auto rounded bg-black p-3 font-mono text-xs text-green-400">
            {output || 'Ready.'}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => {
              const ok = window.confirm('Restart Ollama service?')
              if (ok) restartMut.mutate()
            }}
            disabled={restartMut.isPending}
          >
            {restartMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Restart Ollama
          </Button>
          {restartMut.isError ? <p className="mt-2 text-sm text-destructive">{restartMut.error?.message}</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}
