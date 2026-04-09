import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  getFrameworkConfig,
  getFrameworkModels,
  getFrameworkRunning,
  putFrameworkConfig,
  restartFramework,
  tabbyLoad,
  tabbyUnload,
} from '@/api/machines.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'

export function TabbyApiPanel({ machineId }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [selectedModel, setSelectedModel] = useState('')

  const qRunning = useQuery({
    queryKey: ['framework-running', machineId],
    queryFn: () => getFrameworkRunning(machineId),
    enabled: !!machineId,
    refetchInterval: 15_000,
  })
  const qModels = useQuery({
    queryKey: ['framework-models', machineId],
    queryFn: () => getFrameworkModels(machineId),
    enabled: !!machineId,
  })
  const qConfig = useQuery({
    queryKey: ['framework-config', machineId],
    queryFn: () => getFrameworkConfig(machineId),
    enabled: !!machineId,
  })

  useEffect(() => {
    if (typeof qConfig.data?.yaml_text === 'string') setDraft(qConfig.data.yaml_text)
  }, [qConfig.data?.yaml_text])

  useEffect(() => {
    const models = Array.isArray(qModels.data?.models) ? qModels.data.models : []
    if (!selectedModel && models.length > 0) setSelectedModel(models[0])
  }, [qModels.data?.models, selectedModel])

  const unloadMut = useMutation({
    mutationFn: () => tabbyUnload(machineId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['framework-running', machineId] }),
  })
  const loadMut = useMutation({
    mutationFn: async () => {
      if (!selectedModel) throw new Error('Select a model first')
      return Promise.race([
        tabbyLoad(machineId, selectedModel),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('tabbyAPI load timed out after 90 seconds')), 90_000)
        }),
      ])
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
    },
  })
  const saveMut = useMutation({
    mutationFn: () => putFrameworkConfig(machineId, draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['framework-config', machineId] })
      qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
    },
  })
  const restartMut = useMutation({
    mutationFn: () => restartFramework(machineId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
    },
  })

  const models = Array.isArray(qModels.data?.models) ? qModels.data.models : []
  const dirty = draft !== (qConfig.data?.yaml_text || '')

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Currently loaded model</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <Badge variant="secondary">{qRunning.data?.loaded_model || 'None loaded'}</Badge>
          </div>
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10"
            onClick={() => unloadMut.mutate()}
            disabled={unloadMut.isPending}
          >
            {unloadMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Unload
          </Button>
          {qRunning.isError || unloadMut.isError ? (
            <p className="text-sm text-destructive">{qRunning.error?.message || unloadMut.error?.message}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Load model</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <select
            className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <Button onClick={() => loadMut.mutate()} disabled={loadMut.isPending || !selectedModel}>
            {loadMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Load
          </Button>
          {qModels.isLoading ? <p className="text-sm text-muted-foreground">Loading model list...</p> : null}
          {qModels.isError || loadMut.isError ? (
            <p className="text-sm text-destructive">{qModels.error?.message || loadMut.error?.message}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Config editor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{qConfig.data?.path || 'Config path unavailable'}</p>
          {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
          <Textarea className="min-h-[220px] font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !dirty}>
              {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save & Restart
            </Button>
            <Button variant="outline" onClick={() => restartMut.mutate()} disabled={restartMut.isPending}>
              {restartMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Restart Only
            </Button>
          </div>
          {qConfig.isError || saveMut.isError || restartMut.isError ? (
            <p className="text-sm text-destructive">{qConfig.error?.message || saveMut.error?.message || restartMut.error?.message}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
