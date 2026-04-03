import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ChevronDown, Loader2, Monitor } from 'lucide-react'
import { listMachines } from '@/api/machines.js'
import {
  applyNssmEnv,
  fetchNssmEnv,
  fetchOllamaServiceStatus,
  getGpuStatus,
  restartOllama,
  startOllama,
  stopOllama,
} from '@/api/gpu.js'
import { ApplyTerminalPanel } from '@/components/ApplyTerminalPanel.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { cn } from '@/lib/utils.js'

const ENV_DEFAULTS = {
  CUDA_VISIBLE_DEVICES: '0,1',
  OLLAMA_GPU_LAYERS: '',
  OLLAMA_MAX_LOADED_MODELS: '1',
  OLLAMA_KEEP_ALIVE: '30m',
  OLLAMA_FLASH_ATTENTION: '0',
  OLLAMA_KV_CACHE_TYPE: 'f16',
  OLLAMA_NUM_PARALLEL: '',
  OLLAMA_HOST: '0.0.0.0:11434',
}

const FORM_KEYS = Object.keys(ENV_DEFAULTS)

function formatBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (v < 1024) return `${v} B`
  const kb = v / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(2)} GB`
}

function mergeEnvFromNssm(env) {
  const out = { ...ENV_DEFAULTS }
  const src = env && typeof env === 'object' ? env : {}
  for (const k of FORM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined && src[k] !== null) {
      out[k] = String(src[k])
    }
  }
  return out
}

function envPayload(draft) {
  const o = {}
  for (const k of FORM_KEYS) {
    o[k] = draft[k] ?? ''
  }
  return o
}

const PRESETS = [
  {
    id: 'single',
    title: 'Single GPU (RTX 5090 only)',
    body: `CUDA_VISIBLE_DEVICES=0
OLLAMA_MAX_LOADED_MODELS=1`,
    desc: 'Uses only the primary GPU. Good for large single-GPU workloads.',
    values: { CUDA_VISIBLE_DEVICES: '0', OLLAMA_MAX_LOADED_MODELS: '1' },
  },
  {
    id: 'dual',
    title: 'Dual GPU Auto-Split',
    body: `CUDA_VISIBLE_DEVICES=0,1
OLLAMA_MAX_LOADED_MODELS=1`,
    desc: 'Expose both GPUs to Ollama for automatic layer split across devices.',
    values: { CUDA_VISIBLE_DEVICES: '0,1', OLLAMA_MAX_LOADED_MODELS: '1' },
  },
  {
    id: 'two-models',
    title: 'Two Models Simultaneously',
    body: `CUDA_VISIBLE_DEVICES=0,1
OLLAMA_MAX_LOADED_MODELS=2
OLLAMA_KEEP_ALIVE=30m`,
    desc: 'Allows two loaded models with a typical keep-alive retention.',
    values: {
      CUDA_VISIBLE_DEVICES: '0,1',
      OLLAMA_MAX_LOADED_MODELS: '2',
      OLLAMA_KEEP_ALIVE: '30m',
    },
  },
]

export function GpuPage() {
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const machineFromUrl = searchParams.get('machine')
  const { data: machinePack } = useQuery({
    queryKey: ['machines'],
    queryFn: listMachines,
  })
  const machines = machinePack?.machines ?? []
  const selectedMachineId =
    machineFromUrl && machines.some((m) => String(m.id) === machineFromUrl)
      ? machineFromUrl
      : ''

  const qStatus = useQuery({
    queryKey: ['gpu-status', selectedMachineId || 'default'],
    queryFn: () => getGpuStatus(selectedMachineId || undefined),
    refetchInterval: 15_000,
    retry: false,
  })
  const qSvc = useQuery({
    queryKey: ['gpu-ollama-service-status', selectedMachineId || 'default'],
    queryFn: () => fetchOllamaServiceStatus(selectedMachineId || undefined),
    refetchInterval: 15_000,
    retry: false,
  })
  const qNssm = useQuery({
    queryKey: ['gpu-nssm-env', selectedMachineId || 'default'],
    queryFn: () => fetchNssmEnv(selectedMachineId || undefined),
    retry: false,
  })

  const [draft, setDraft] = useState(() => ({ ...ENV_DEFAULTS }))
  useEffect(() => {
    if (qNssm.data?.env && !qNssm.data.error) {
      setDraft(mergeEnvFromNssm(qNssm.data.env))
    }
  }, [qNssm.data])

  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalLines, setTerminalLines] = useState([])
  const [terminalRunning, setTerminalRunning] = useState(false)
  const [terminalResult, setTerminalResult] = useState(null)
  const [needsRestartHint, setNeedsRestartHint] = useState(false)
  const [applyBusy, setApplyBusy] = useState(false)
  const [hwRefOpen, setHwRefOpen] = useState(false)

  const svcStatus = qSvc.data?.status ?? 'Unknown'
  const isRunning = svcStatus === 'Running'
  const isStopped = svcStatus === 'Stopped'

  const runningModels = useMemo(() => {
    const rm = qStatus.data?.running_models
    return Array.isArray(rm) ? rm : []
  }, [qStatus.data])

  const runStream = useCallback(async (label, run) => {
    setTerminalOpen(true)
    setTerminalRunning(true)
    setTerminalResult(null)
    setTerminalLines((prev) => (label && prev.length ? [...prev, `--- ${label} ---`] : label ? [label] : []))

    let sawDone = false
    let sawErr = false
    try {
      await run((ev) => {
        if (ev.type === 'log' && ev.line != null) {
          setTerminalLines((p) => [...p, String(ev.line)])
        }
        if (ev.type === 'error') {
          sawErr = true
          setTerminalLines((p) => [...p, ev.message || 'Error'])
          setTerminalResult('failed')
        }
        if (ev.type === 'done' && ev.success) {
          sawDone = true
          if (ev.ollama_version != null && String(ev.ollama_version).length) {
            setTerminalLines((p) => [...p, `Ollama version: ${ev.ollama_version}`])
          }
          setTerminalResult('success')
        }
      })
      if (!sawDone && !sawErr) {
        setTerminalLines((p) => [...p, 'Stream ended without completion'])
        setTerminalResult('failed')
      }
      return sawDone && !sawErr
    } catch (e) {
      const msg = e.message || 'Failed'
      setTerminalLines((p) => [...p, msg])
      setTerminalResult('failed')
      return false
    } finally {
      setTerminalRunning(false)
    }
  }, [])

  const openFreshTerminal = useCallback(() => {
    setTerminalLines([])
    setTerminalResult(null)
    setTerminalOpen(true)
    setTerminalRunning(true)
  }, [])

  const handleApplyOnly = useCallback(async () => {
    const n = Number(draft.OLLAMA_MAX_LOADED_MODELS)
    if (!Number.isInteger(n) || n < 1 || n > 8) {
      openFreshTerminal()
      setTerminalRunning(false)
      setTerminalOpen(true)
      setTerminalLines(['OLLAMA_MAX_LOADED_MODELS must be an integer 1–8.'])
      setTerminalResult('failed')
      return
    }
    setApplyBusy(true)
    const mid = selectedMachineId || undefined
    const ok = await runStream('', (onEvent) => applyNssmEnv(envPayload(draft), onEvent, undefined, mid))
    setApplyBusy(false)
    if (ok) {
      setNeedsRestartHint(true)
      qc.invalidateQueries({ queryKey: ['gpu-nssm-env'] })
    }
  }, [draft, openFreshTerminal, qc, runStream, selectedMachineId])

  const handleRestartOnly = useCallback(async () => {
    setApplyBusy(true)
    const mid = selectedMachineId || undefined
    const ok = await runStream('', (onEvent) => restartOllama(onEvent, undefined, mid))
    setApplyBusy(false)
    if (ok) {
      setNeedsRestartHint(false)
      qc.invalidateQueries({ queryKey: ['gpu-status'] })
      qc.invalidateQueries({ queryKey: ['gpu-ollama-service-status'] })
      qc.invalidateQueries({ queryKey: ['gpu-nssm-env'] })
    }
  }, [qc, runStream, selectedMachineId])

  const handleApplyAndRestart = useCallback(async () => {
    const n = Number(draft.OLLAMA_MAX_LOADED_MODELS)
    if (!Number.isInteger(n) || n < 1 || n > 8) {
      openFreshTerminal()
      setTerminalRunning(false)
      setTerminalOpen(true)
      setTerminalLines(['OLLAMA_MAX_LOADED_MODELS must be an integer 1–8.'])
      setTerminalResult('failed')
      return
    }
    setApplyBusy(true)
    const mid = selectedMachineId || undefined
    const ok1 = await runStream('', (onEvent) => applyNssmEnv(envPayload(draft), onEvent, undefined, mid))
    if (!ok1) {
      setApplyBusy(false)
      return
    }
    setTerminalLines((p) => [...p, '--- restart OllamaService ---'])
    setTerminalRunning(true)
    setTerminalResult(null)
    let sawDone = false
    let sawErr = false
    try {
      await restartOllama((ev) => {
        if (ev.type === 'log' && ev.line != null) {
          setTerminalLines((p2) => [...p2, String(ev.line)])
        }
        if (ev.type === 'error') {
          sawErr = true
          setTerminalLines((p2) => [...p2, ev.message || 'Error'])
          setTerminalResult('failed')
        }
        if (ev.type === 'done' && ev.success) {
          sawDone = true
          if (ev.ollama_version != null && String(ev.ollama_version).length) {
            setTerminalLines((p2) => [...p2, `Ollama version: ${ev.ollama_version}`])
          }
          setTerminalResult('success')
        }
      }, undefined, mid)
      if (!sawDone && !sawErr) {
        setTerminalLines((p) => [...p, 'Stream ended without completion'])
        setTerminalResult('failed')
      }
      if (sawDone && !sawErr) {
        setNeedsRestartHint(false)
        qc.invalidateQueries({ queryKey: ['gpu-status'] })
        qc.invalidateQueries({ queryKey: ['gpu-ollama-service-status'] })
        qc.invalidateQueries({ queryKey: ['gpu-nssm-env'] })
      }
    } catch (e) {
      setTerminalLines((p) => [...p, e.message || 'Failed'])
      setTerminalResult('failed')
    } finally {
      setTerminalRunning(false)
      setApplyBusy(false)
    }
  }, [draft, qc, runStream, selectedMachineId])

  const handleStop = useCallback(async () => {
    setApplyBusy(true)
    const mid = selectedMachineId || undefined
    const ok = await runStream('', (onEvent) => stopOllama(onEvent, undefined, mid))
    setApplyBusy(false)
    if (ok) {
      qc.invalidateQueries({ queryKey: ['gpu-ollama-service-status'] })
      qc.invalidateQueries({ queryKey: ['gpu-status'] })
    }
  }, [qc, runStream, selectedMachineId])

  const handleStart = useCallback(async () => {
    setApplyBusy(true)
    const mid = selectedMachineId || undefined
    const ok = await runStream('', (onEvent) => startOllama(onEvent, undefined, mid))
    setApplyBusy(false)
    if (ok) {
      qc.invalidateQueries({ queryKey: ['gpu-ollama-service-status'] })
      qc.invalidateQueries({ queryKey: ['gpu-status'] })
    }
  }, [qc, runStream, selectedMachineId])

  const loadPreset = useCallback((preset) => {
    setDraft((d) => ({ ...d, ...preset.values }))
  }, [])

  const hostLabel = useMemo(() => {
    if (selectedMachineId) {
      const m = machines.find((x) => String(x.id) === selectedMachineId)
      return m?.name || 'Machine'
    }
    return 'sam-desktop'
  }, [machines, selectedMachineId])

  const sshKind = qStatus.data?.ssh_type || (selectedMachineId ? 'nssm' : 'nssm')

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold">GPU &amp; Inference Config</h1>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <Label className="text-xs text-muted-foreground shrink-0">Target host</Label>
          <select
            className="flex h-9 max-w-md rounded-md border border-border bg-background px-2 text-sm"
            value={selectedMachineId}
            onChange={(e) => {
              const v = e.target.value
              if (v) setSearchParams({ machine: v })
              else setSearchParams({})
            }}
          >
            <option value="">sam-desktop (default)</option>
            {machines.map((m) => (
              <option key={m.id} value={String(m.id)}>
                {m.name} — {m.gpu_label || m.ollama_url}
              </option>
            ))}
          </select>
        </div>
        <p className="text-sm text-muted-foreground">
          {sshKind === 'systemd'
            ? `systemd Ollama on ${hostLabel} — env via drop-in override over SSH.`
            : `NSSM Ollama service on ${hostLabel} — AppEnvironmentExtra over SSH.`}
        </p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-2">
          <Monitor className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">OllamaService</CardTitle>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
                  isRunning && 'border-emerald-500/50 text-emerald-400',
                  isStopped && 'border-muted-foreground/40 text-muted-foreground',
                  !isRunning && !isStopped && 'border-amber-500/40 text-amber-200',
                )}
              >
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    isRunning && 'bg-emerald-400',
                    isStopped && 'bg-muted-foreground',
                    !isRunning && !isStopped && 'bg-amber-400',
                  )}
                  aria-hidden
                />
                {svcStatus}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {(() => {
                const ver = qStatus.data?.ollama_version
                if (ver) {
                  const s = String(ver)
                  const shown = s.toLowerCase().startsWith('v') ? s : `v${s}`
                  return `${shown} on ${hostLabel}`
                }
                if (qStatus.isLoading) return `Loading Ollama version…`
                return `— on ${hostLabel}`
              })()}
              {runningModels.length > 0 || qStatus.data?.vram_used_bytes != null ? (
                <>
                  {' · '}
                  {qStatus.data?.gpu_info ? `${qStatus.data.gpu_info} · ` : ''}
                  {runningModels.length} model{runningModels.length === 1 ? '' : 's'} loaded
                  {qStatus.data?.vram_used_bytes != null
                    ? ` · ${formatBytes(qStatus.data.vram_used_bytes)} VRAM`
                    : ''}
                </>
              ) : null}
            </p>
            {qSvc.data?.raw ? (
              <p className="font-mono-ui text-[11px] text-muted-foreground/80">nssm: {qSvc.data.raw}</p>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {isRunning && (
            <>
              <Button type="button" variant="destructive" size="sm" disabled={applyBusy} onClick={handleStop}>
                Stop
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={applyBusy || !isRunning}
                onClick={handleRestartOnly}
              >
                Restart
              </Button>
            </>
          )}
          {isStopped && (
            <Button type="button" size="sm" disabled={applyBusy} onClick={handleStart}>
              Start
            </Button>
          )}
          {!isRunning && !isStopped && (
            <>
              <Button type="button" variant="secondary" size="sm" disabled={applyBusy} onClick={handleStart}>
                Start
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={applyBusy} onClick={handleStop}>
                Stop
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={applyBusy || !isRunning}
                onClick={handleRestartOnly}
              >
                Restart
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {(qStatus.isError || qNssm.isError) && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="py-4 text-sm text-destructive">
            {qStatus.isError && <p>Could not load Ollama GPU status (admin token required for /api/gpu/status).</p>}
            {qNssm.isError && <p>Could not load NSSM environment from SSH (admin token required).</p>}
          </CardContent>
        </Card>
      )}

      {qNssm.data?.error && (
        <Card className="border-amber-500/40 bg-amber-500/10">
          <CardContent className="py-4 text-sm text-amber-100">
            NSSM env: {qNssm.data.error}
          </CardContent>
        </Card>
      )}

      {needsRestartHint && (
        <Card className="border-sky-500/40 bg-sky-950/30">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-sky-100">Restart Ollama to apply environment changes.</p>
            <Button type="button" size="sm" variant="secondary" disabled={applyBusy} onClick={handleRestartOnly}>
              Restart Ollama
            </Button>
          </CardContent>
        </Card>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Environment variables</h2>
        <p className="text-sm text-muted-foreground">
          {sshKind === 'systemd' ? (
            <>
              Values read from <code className="font-mono-ui text-xs">systemctl show ollama</code>. Applying writes a systemd
              drop-in at <code className="font-mono-ui text-xs">/etc/systemd/system/ollama.service.d/99-ollamactl.conf</code> and
              runs <code className="font-mono-ui text-xs">daemon-reload</code>.
            </>
          ) : (
            <>
              Values load from NSSM on the remote host. Applying updates <code className="font-mono-ui text-xs">AppEnvironmentExtra</code>{' '}
              for <code className="font-mono-ui text-xs">OllamaService</code>.
            </>
          )}
        </p>

        {qNssm.isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading remote environment…
          </div>
        )}

        <div className="space-y-4">
          <EnvRow
            label="CUDA_VISIBLE_DEVICES"
            hint="0 = RTX 5090 only; 0,1 = both"
            draft={draft.CUDA_VISIBLE_DEVICES}
            onChange={(v) => setDraft((d) => ({ ...d, CUDA_VISIBLE_DEVICES: v }))}
          />
          <div className="rounded-md border border-border bg-card p-4 space-y-3">
            <Label className="font-mono-ui text-sm">OLLAMA_GPU_LAYERS</Label>
            <p className="text-sm text-muted-foreground">Layers on GPU; empty = auto.</p>
            <Input
              type="number"
              className="font-mono-ui sm:max-w-xs"
              placeholder="(empty = auto)"
              value={draft.OLLAMA_GPU_LAYERS}
              onChange={(e) => setDraft((d) => ({ ...d, OLLAMA_GPU_LAYERS: e.target.value }))}
            />
          </div>
          <div className="rounded-md border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="font-mono-ui text-sm">OLLAMA_MAX_LOADED_MODELS</Label>
              <span className="text-xs text-muted-foreground">1–8</span>
            </div>
            <p className="text-sm text-muted-foreground">Max models in VRAM at once.</p>
            <Input
              type="number"
              min={1}
              max={8}
              className="font-mono-ui sm:max-w-xs"
              value={draft.OLLAMA_MAX_LOADED_MODELS}
              onChange={(e) => setDraft((d) => ({ ...d, OLLAMA_MAX_LOADED_MODELS: e.target.value }))}
            />
          </div>
          <EnvRow
            label="OLLAMA_KEEP_ALIVE"
            hint="e.g. 30m, 1h, 0, -1"
            draft={draft.OLLAMA_KEEP_ALIVE}
            onChange={(v) => setDraft((d) => ({ ...d, OLLAMA_KEEP_ALIVE: v }))}
          />
          <div className="rounded-md border border-border bg-card p-4 space-y-3">
            <Label className="font-mono-ui text-sm">OLLAMA_FLASH_ATTENTION</Label>
            <p className="text-sm text-muted-foreground">Less VRAM, minimal quality impact when supported.</p>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={draft.OLLAMA_FLASH_ATTENTION === '1'}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, OLLAMA_FLASH_ATTENTION: e.target.checked ? '1' : '0' }))
                }
              />
              <span>Enable (1)</span>
            </label>
          </div>
          <div className="rounded-md border border-border bg-card p-4 space-y-3">
            <Label className="font-mono-ui text-sm">OLLAMA_KV_CACHE_TYPE</Label>
            <select
              className="flex h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm font-mono-ui"
              value={draft.OLLAMA_KV_CACHE_TYPE}
              onChange={(e) => setDraft((d) => ({ ...d, OLLAMA_KV_CACHE_TYPE: e.target.value }))}
            >
              <option value="f16">f16</option>
              <option value="q8_0">q8_0</option>
              <option value="q4_0">q4_0</option>
            </select>
          </div>
          <div className="rounded-md border border-border bg-card p-4 space-y-2 text-sm text-muted-foreground leading-relaxed">
            <p>
              <span className="font-semibold text-foreground">f16</span> — Full precision; best quality; ~2GB per 8K ctx on
              a 9B model.
            </p>
            <p>
              <span className="font-semibold text-foreground">q8_0</span> — Recommended; ~50% less KV VRAM; minimal quality
              loss.
            </p>
            <p>
              <span className="font-semibold text-foreground">q4_0</span> — Max savings; ~75% less KV VRAM; more noticeable on
              long context.
            </p>
          </div>
          <EnvRow
            label="OLLAMA_NUM_PARALLEL"
            hint="empty = auto"
            draft={draft.OLLAMA_NUM_PARALLEL}
            onChange={(v) => setDraft((d) => ({ ...d, OLLAMA_NUM_PARALLEL: v }))}
          />
          <EnvRow
            label="OLLAMA_HOST"
            hint="default 0.0.0.0:11434"
            draft={draft.OLLAMA_HOST}
            onChange={(v) => setDraft((d) => ({ ...d, OLLAMA_HOST: v }))}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={applyBusy || qNssm.isLoading} onClick={handleApplyOnly}>
            Apply changes
          </Button>
          <Button type="button" variant="secondary" disabled={applyBusy || qNssm.isLoading} onClick={handleApplyAndRestart}>
            Apply &amp; restart
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">GPU presets</h2>
        <p className="text-sm text-muted-foreground">Load into the form only — does not apply until you click Apply.</p>
        <div className="flex flex-col gap-4">
          {PRESETS.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="text-base">{p.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono-ui text-xs">{p.body}</pre>
                <p className="text-muted-foreground">{p.desc}</p>
                <Button type="button" size="sm" variant="secondary" onClick={() => loadPreset(p)}>
                  Load preset
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Collapsible open={hwRefOpen} onOpenChange={setHwRefOpen} className="rounded-md border border-border">
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium hover:bg-muted/30">
          Hardware reference
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 opacity-60 transition-transform', hwRefOpen && 'rotate-180')}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="border-t border-border px-4 py-3 font-mono-ui text-xs leading-relaxed text-muted-foreground md:text-sm">
            {`${hostLabel} (reference)
├── sam-desktop: Windows 11, RTX 5090, NSSM OllamaService
├── gpu: Ubuntu 24.04, RTX 4080 Super, systemd ollama
└── Pick "Target host" above for SSH env + service controls`}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      <ApplyTerminalPanel
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        lines={terminalLines}
        running={terminalRunning}
        result={
          terminalResult === 'success' ? 'success' : terminalResult === 'failed' ? 'failed' : null
        }
      />
    </div>
  )
}

function EnvRow({ label, hint, draft, onChange }) {
  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <Label className="font-mono-ui text-sm">{label}</Label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <Input type="text" className="font-mono-ui sm:max-w-lg" value={draft} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
