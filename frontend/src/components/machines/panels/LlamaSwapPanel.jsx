import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Clock, Loader2 } from 'lucide-react'
import * as yaml from 'js-yaml'
import {
  getFrameworkConfig,
  getFrameworkModels,
  getFrameworkRunning,
  putFrameworkConfig,
  restartFramework,
  unloadFramework,
  warmFramework,
} from '@/api/machines.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'
import { ConfigBackupDrawer } from '@/components/machines/ConfigBackupDrawer.jsx'

function parseModelParams(cmd, modelObj) {
  const text = String(cmd || '')
  const ctx = text.match(/--ctx-size\s+(\d+)/)
  const ngl = text.match(/(?:^|\s)-ngl\s+(\d+)/)
  return {
    ctxSize: ctx ? Number(ctx[1]) : '',
    gpuLayers: ngl ? Number(ngl[1]) : '',
    flashAttn: /(?:^|\s)--flash-attn(?:\s|$)/.test(text),
    jinja: /(?:^|\s)--jinja(?:\s|$)/.test(text),
    ttl: modelObj?.ttl != null && !Number.isNaN(Number(modelObj.ttl)) ? Number(modelObj.ttl) : '',
  }
}

function replaceOrAppendNumberArg(cmd, argRegex, token, value) {
  const text = String(cmd || '')
  if (value === '' || value == null || Number.isNaN(Number(value))) return text
  const next = `${token} ${Number(value)}`
  if (argRegex.test(text)) return text.replace(argRegex, next)
  return `${text} ${next}`.trim()
}

function toggleFlag(cmd, flag, enabled) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const withoutFlag = String(cmd || '')
    .replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!enabled) return withoutFlag
  return `${withoutFlag} ${flag}`.trim()
}

export function LlamaSwapPanel({ machineId }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [warmPendingModel, setWarmPendingModel] = useState(null)
  const [paramsOpen, setParamsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

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
    refetchInterval: 60_000,
  })
  const qConfig = useQuery({
    queryKey: ['framework-config', machineId],
    queryFn: () => getFrameworkConfig(machineId),
    enabled: !!machineId,
  })

  useEffect(() => {
    if (typeof qConfig.data?.yaml_text === 'string') setDraft(qConfig.data.yaml_text)
  }, [qConfig.data?.yaml_text])

  const unloadMut = useMutation({
    mutationFn: () => unloadFramework(machineId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
    },
  })
  const warmMut = useMutation({
    mutationFn: (model) => warmFramework(machineId, model),
    onMutate: (model) => {
      setWarmPendingModel(model)
    },
    onSettled: () => {
      setWarmPendingModel(null)
      qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
    },
  })
  const saveMut = useMutation({
    mutationFn: () => putFrameworkConfig(machineId, draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['framework-config', machineId] })
      qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
      qc.invalidateQueries({ queryKey: ['framework-models', machineId] })
    },
  })
  const restartMut = useMutation({
    mutationFn: () => restartFramework(machineId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['framework-running', machineId] })
    },
  })

  const loadedModel = qRunning.data?.loaded_model || null
  const modelList = Array.isArray(qModels.data?.models)
    ? qModels.data.models.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
    : []
  const dirty = draft !== (qConfig.data?.yaml_text || '')

  const parsedModels = useMemo(() => {
    try {
      const parsed = yaml.load(draft) || {}
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      const models = parsed.models
      if (!models || typeof models !== 'object' || Array.isArray(models)) return []
      return Object.entries(models).map(([name, cfg]) => ({
        name,
        cfg: cfg && typeof cfg === 'object' ? cfg : {},
      }))
    } catch {
      return []
    }
  }, [draft])

  const patchDraftForModel = (modelName, updater) => {
    try {
      const parsed = yaml.load(draft) || {}
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      if (!parsed.models || typeof parsed.models !== 'object' || Array.isArray(parsed.models)) return
      const current = parsed.models[modelName]
      const nextModel = updater(current && typeof current === 'object' ? { ...current } : {})
      parsed.models[modelName] = nextModel
      setDraft(yaml.dump(parsed, { lineWidth: -1 }))
    } catch {
      // Invalid YAML in editor: keep raw draft untouched.
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Currently loaded model</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <Badge variant="secondary">{loadedModel || 'None loaded'}</Badge>
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
          <CardTitle className="text-base">Model list</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {qModels.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading models...
            </div>
          ) : (
            modelList.map((model) => (
              <div
                key={model}
                className={`flex items-center justify-between rounded-md border px-3 py-2 ${
                  loadedModel === model ? 'border-primary bg-primary/5' : 'border-border'
                }`}
              >
                <span className="font-mono text-xs">{model}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={warmMut.isPending && warmPendingModel === model}
                  onClick={() => warmMut.mutate(model)}
                >
                  {warmMut.isPending && warmPendingModel === model ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Warm
                </Button>
              </div>
            ))
          )}
          {!qModels.isLoading && modelList.length === 0 ? <p className="text-sm text-muted-foreground">No models found.</p> : null}
          {qModels.isError || warmMut.isError ? (
            <p className="text-sm text-destructive">{qModels.error?.message || warmMut.error?.message}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Config editor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{qConfig.data?.path || 'Config path unavailable'}</p>
          <div className="flex items-center gap-2">
            {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
          </div>
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
            <Button type="button" variant="outline" size="icon" title="History" onClick={() => setHistoryOpen(true)}>
              <Clock className="h-4 w-4" />
            </Button>
          </div>
          {qConfig.isError || saveMut.isError || restartMut.isError ? (
            <p className="text-sm text-destructive">{qConfig.error?.message || saveMut.error?.message || restartMut.error?.message}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model Parameters</CardTitle>
        </CardHeader>
        <CardContent>
          <Collapsible open={paramsOpen} onOpenChange={setParamsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm">
                <ChevronDown className={`h-4 w-4 transition-transform ${paramsOpen ? 'rotate-180' : ''}`} />
                {paramsOpen ? 'Hide Parameters' : 'Show Parameters'}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-3">
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Editing parameters modifies the raw config. Review the YAML editor below before saving.
              </div>
              {parsedModels.length === 0 ? (
                <p className="text-sm text-muted-foreground">No editable models found in YAML.</p>
              ) : (
                parsedModels.map(({ name, cfg }) => {
                  const p = parseModelParams(cfg?.cmd, cfg)
                  return (
                    <div key={name} className="space-y-2 rounded-md border border-border p-3">
                      <p className="font-mono text-xs">{name}</p>
                      <div className="grid gap-2 md:grid-cols-5">
                        <Input
                          type="number"
                          placeholder="Context size"
                          value={p.ctxSize}
                          onChange={(e) =>
                            patchDraftForModel(name, (modelObj) => ({
                              ...modelObj,
                              cmd: replaceOrAppendNumberArg(modelObj.cmd, /--ctx-size\s+\d+/, '--ctx-size', e.target.value),
                            }))
                          }
                        />
                        <Input
                          type="number"
                          placeholder="GPU layers"
                          value={p.gpuLayers}
                          onChange={(e) =>
                            patchDraftForModel(name, (modelObj) => ({
                              ...modelObj,
                              cmd: replaceOrAppendNumberArg(modelObj.cmd, /(?:^|\s)-ngl\s+\d+/, '-ngl', e.target.value),
                            }))
                          }
                        />
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={p.flashAttn}
                            onChange={(e) =>
                              patchDraftForModel(name, (modelObj) => ({
                                ...modelObj,
                                cmd: toggleFlag(modelObj.cmd, '--flash-attn', e.target.checked),
                              }))
                            }
                          />
                          Flash attention
                        </label>
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={p.jinja}
                            onChange={(e) =>
                              patchDraftForModel(name, (modelObj) => ({
                                ...modelObj,
                                cmd: toggleFlag(modelObj.cmd, '--jinja', e.target.checked),
                              }))
                            }
                          />
                          Jinja
                        </label>
                        <Input
                          type="number"
                          placeholder="TTL (seconds)"
                          value={p.ttl}
                          onChange={(e) =>
                            patchDraftForModel(name, (modelObj) => ({
                              ...modelObj,
                              ttl: e.target.value === '' ? '' : Number(e.target.value),
                            }))
                          }
                        />
                      </div>
                    </div>
                  )
                })
              )}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <ConfigBackupDrawer
        machineId={machineId}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestore={() => {
          qc.invalidateQueries({ queryKey: ['framework-config', machineId] })
          qc.invalidateQueries({ queryKey: ['config-backups', machineId] })
        }}
      />
    </div>
  )
}
