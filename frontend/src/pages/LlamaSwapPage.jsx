import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Power, Save, Trash2 } from 'lucide-react'
import {
  getLlamaSwapConfig,
  getLlamaSwapRunning,
  listLlamaSwapModels,
  putLlamaSwapConfig,
  restartLlamaSwapService,
  unloadLlamaSwap,
  warmLlamaSwap,
} from '@/api/llamaswap.js'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'

const IDS = new Set(['sam-desktop', 'gpu'])

export function LlamaSwapPage() {
  const { machineId: rawId } = useParams()
  const machineId = decodeURIComponent(rawId || '')
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')

  const valid = IDS.has(machineId)

  const qConfig = useQuery({
    queryKey: ['llamaswap-config', machineId],
    queryFn: () => getLlamaSwapConfig(machineId),
    enabled: valid,
  })

  const qModels = useQuery({
    queryKey: ['llamaswap-models', machineId],
    queryFn: () => listLlamaSwapModels(machineId),
    enabled: valid,
    refetchInterval: 60_000,
  })

  const qRunning = useQuery({
    queryKey: ['llamaswap-running', machineId],
    queryFn: () => getLlamaSwapRunning(machineId),
    enabled: valid,
    refetchInterval: 15_000,
  })

  useEffect(() => {
    if (qConfig.data?.yaml_text != null) setDraft(qConfig.data.yaml_text)
  }, [qConfig.data?.yaml_text])

  const saveMut = useMutation({
    mutationFn: () => putLlamaSwapConfig(machineId, draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['llamaswap-config', machineId] })
      qc.invalidateQueries({ queryKey: ['llamaswap-models', machineId] })
      qc.invalidateQueries({ queryKey: ['llamaswap-running', machineId] })
    },
  })

  const restartMut = useMutation({
    mutationFn: () => restartLlamaSwapService(machineId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llamaswap-running', machineId] }),
  })

  const unloadMut = useMutation({
    mutationFn: () => unloadLlamaSwap(machineId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llamaswap-running', machineId] }),
  })

  const warmMut = useMutation({
    mutationFn: (model) => warmLlamaSwap(machineId, model),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['llamaswap-running'] })
    },
  })

  if (!valid) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <p className="text-destructive">Unknown machine: {machineId || '(missing)'}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/machines">
            <ArrowLeft className="mr-2 h-4 w-4" /> Back to machines
          </Link>
        </Button>
      </div>
    )
  }

  const models = qModels.data?.models ?? []
  const running = qRunning.data?.running

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-1 w-fit" asChild>
            <Link to="/machines">
              <ArrowLeft className="mr-2 h-4 w-4" /> Machines
            </Link>
          </Button>
          <h1 className="text-2xl font-bold">llama-swap · {machineId}</h1>
          <p className="text-sm text-muted-foreground">Config on the remote host, HTTP status from llama-swap URL env.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => restartMut.mutate()} disabled={restartMut.isPending}>
            {restartMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Power className="mr-2 h-4 w-4" />}
            Restart service
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => unloadMut.mutate()} disabled={unloadMut.isPending}>
            {unloadMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Unload model
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configured models</CardTitle>
          <CardDescription>IDs from the <code className="font-mono-ui text-xs">models:</code> map in YAML.</CardDescription>
        </CardHeader>
        <CardContent>
          {qModels.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <ul className="space-y-2">
              {models.length === 0 && <li className="text-sm text-muted-foreground">None</li>}
              {models.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5"
                >
                  <span className="font-mono-ui text-xs">{m.id}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={warmMut.isPending}
                    onClick={() => warmMut.mutate(m.id)}
                  >
                    {warmMut.isPending && warmMut.variables === m.id ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Warm
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {warmMut.isError && (
            <p className="mt-2 text-sm text-destructive">{warmMut.error?.message || 'Warm failed'}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Running</CardTitle>
          <CardDescription>From llama-swap <code className="font-mono-ui text-xs">GET /running</code></CardDescription>
        </CardHeader>
        <CardContent>
          {qRunning.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/20 p-3 font-mono-ui text-xs">
              {JSON.stringify(running, null, 2)}
            </pre>
          )}
          {qRunning.isError && (
            <p className="mt-2 text-sm text-destructive">Could not reach llama-swap — check SAMDESKTOP_LLAMASWAP_URL / GPU_LLAMASWAP_URL.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">config.yaml</CardTitle>
          <CardDescription>
            {qConfig.data?.path && (
              <span className="font-mono-ui text-xs break-all text-muted-foreground">{qConfig.data.path}</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            className="min-h-[280px] font-mono-ui text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          <Button type="button" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save &amp; restart llama-swap
          </Button>
          {saveMut.isError && (
            <p className="text-sm text-destructive">{saveMut.error?.message || 'Save failed'}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
