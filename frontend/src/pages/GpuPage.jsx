import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Copy, Loader2, Monitor } from 'lucide-react'
import {
  getGpuConfig,
  getGpuStatus,
  markGpuConfigApplied,
  putGpuConfig,
} from '@/api/gpu.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'

const SAM_DESKTOP_TAILSCALE = '100.101.41.16'

const ENV_DEFAULTS = {
  CUDA_VISIBLE_DEVICES: '0,1',
  OLLAMA_GPU_LAYERS: '',
  OLLAMA_MAX_LOADED_MODELS: '1',
  OLLAMA_KEEP_ALIVE: '30m',
  OLLAMA_FLASH_ATTENTION: '0',
  OLLAMA_KV_CACHE_TYPE: 'f16',
}

const TRACKED_KEYS = Object.keys(ENV_DEFAULTS)

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

function effectiveConfig(configMap) {
  const out = { ...ENV_DEFAULTS }
  const src = configMap && typeof configMap === 'object' ? configMap : {}
  for (const k of TRACKED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined && src[k] !== null) {
      out[k] = String(src[k])
    }
  }
  return out
}

function buildPowerShell(env) {
  const pairs = []
  pairs.push(`"CUDA_VISIBLE_DEVICES=${env.CUDA_VISIBLE_DEVICES}" \\`)
  if (env.OLLAMA_GPU_LAYERS.trim()) {
    pairs.push(`"OLLAMA_GPU_LAYERS=${env.OLLAMA_GPU_LAYERS.trim()}" \\`)
  }
  pairs.push(`"OLLAMA_MAX_LOADED_MODELS=${env.OLLAMA_MAX_LOADED_MODELS}" \\`)
  pairs.push(`"OLLAMA_KEEP_ALIVE=${env.OLLAMA_KEEP_ALIVE}" \\`)
  pairs.push(`"OLLAMA_FLASH_ATTENTION=${env.OLLAMA_FLASH_ATTENTION === '1' ? '1' : '0'}" \\`)
  pairs.push(`"OLLAMA_KV_CACHE_TYPE=${env.OLLAMA_KV_CACHE_TYPE}"`)

  const lines = [
    '# Apply Ollama NSSM environment variables',
    `# Run these commands in PowerShell on sam-desktop (${SAM_DESKTOP_TAILSCALE})`,
    '# ollamactl only generates this script — it does NOT run it.',
    '',
    'C:\\Tools\\nssm set OllamaService AppEnvironmentExtra `',
    ...pairs,
    '',
    '# Restart the service to apply changes',
    'C:\\Tools\\nssm restart OllamaService',
  ]
  return lines.join('\n')
}

const PRESETS = [
  {
    id: 'a',
    title: 'Configuration A: Single GPU (current)',
    body: `CUDA_VISIBLE_DEVICES=0
OLLAMA_MAX_LOADED_MODELS=1`,
    desc: 'Best for large models (27B+). All VRAM on RTX 5090.',
    values: { CUDA_VISIBLE_DEVICES: '0', OLLAMA_MAX_LOADED_MODELS: '1' },
  },
  {
    id: 'b',
    title: 'Configuration B: Dual GPU auto-split',
    body: `CUDA_VISIBLE_DEVICES=0,1
OLLAMA_MAX_LOADED_MODELS=1`,
    desc: 'Best for very large models split across both GPUs. Ollama distributes layers automatically.',
    values: { CUDA_VISIBLE_DEVICES: '0,1', OLLAMA_MAX_LOADED_MODELS: '1' },
  },
  {
    id: 'c',
    title: 'Configuration C: Two models simultaneously',
    body: `CUDA_VISIBLE_DEVICES=0,1
OLLAMA_MAX_LOADED_MODELS=2`,
    desc: 'Best for running a smaller model on the 4080 Super while a larger model uses the 5090.',
    values: { CUDA_VISIBLE_DEVICES: '0,1', OLLAMA_MAX_LOADED_MODELS: '2' },
  },
]

export function GpuPage() {
  const qc = useQueryClient()
  const qStatus = useQuery({
    queryKey: ['gpu-status'],
    queryFn: getGpuStatus,
    refetchInterval: 15_000,
    retry: false,
  })
  const qConfig = useQuery({
    queryKey: ['gpu-config'],
    queryFn: getGpuConfig,
    retry: false,
  })

  const serverConfig = qConfig.data?.config
  const effective = useMemo(() => effectiveConfig(serverConfig), [serverConfig])
  const [draft, setDraft] = useState(() => ({ ...ENV_DEFAULTS }))

  useEffect(() => {
    if (serverConfig) setDraft(effectiveConfig(serverConfig))
  }, [serverConfig])

  const putMut = useMutation({
    mutationFn: ({ key, value }) => putGpuConfig(key, value),
    onSuccess: (data) => {
      qc.setQueryData(['gpu-config'], data)
    },
  })

  const appliedMut = useMutation({
    mutationFn: markGpuConfigApplied,
    onSuccess: (data) => {
      qc.setQueryData(['gpu-config'], data)
    },
  })

  const pending = !!qConfig.data?.pending_changes
  const script = useMemo(() => buildPowerShell(effective), [effective])

  const copyScript = useCallback(() => {
    navigator.clipboard?.writeText(script).catch(() => {})
  }, [script])

  const saveRow = (key, value) => {
    putMut.mutate({ key, value })
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const applyPreset = async (preset) => {
    const entries = Object.entries(preset.values)
    let last = qConfig.data
    for (const [key, value] of entries) {
      last = await putGpuConfig(key, value)
      setDraft((d) => ({ ...d, [key]: value }))
    }
    qc.setQueryData(['gpu-config'], last)
  }

  const running = qStatus.data?.running_models
  const runList = Array.isArray(running) ? running : []
  const vramBytes = qStatus.data?.vram_used_bytes

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">GPU &amp; Inference Config</h1>
        <p className="text-sm text-muted-foreground">
          Tune how Ollama uses GPUs on sam-desktop. This UI runs on the homelab control plane; NSSM changes must be
          executed on Windows at {SAM_DESKTOP_TAILSCALE}.
        </p>
      </header>

      <Card className="border-amber-500/40 bg-amber-500/10">
        <CardContent className="flex gap-3 py-4 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="font-medium text-amber-100">Runs on sam-desktop, not the homelab</p>
            <p className="text-muted-foreground">
              ollamactl cannot edit the NSSM service environment remotely. Saving values here stores your{' '}
              <strong>desired</strong> config in SQLite and generates PowerShell for you to paste on sam-desktop.
            </p>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Current status</h2>
        {qStatus.isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading…
          </div>
        )}
        {qStatus.isError && (
          <Card className="border-destructive/50 bg-destructive/10">
            <CardContent className="py-4 text-sm text-destructive">
              Could not load GPU status. Set{' '}
              <code className="font-mono-ui">boolab_owner_token</code> in localStorage to match the API token, or
              enable <code className="font-mono-ui">OLLAMACTL_SKIP_AUTH</code> for local dev.
            </CardContent>
          </Card>
        )}
        {qStatus.data && (
          <Card>
            <CardHeader className="flex flex-row items-start gap-2 space-y-0">
              <Monitor className="h-5 w-5 shrink-0 text-primary" />
              <CardTitle className="text-base">Live Ollama</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">Ollama version</span>
                <span className="font-mono-ui font-medium">{qStatus.data.ollama_version ?? '—'}</span>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">Running models</span>
                <span className="font-medium">{runList.length}</span>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">VRAM in use (reported)</span>
                <span className="font-medium">{formatBytes(vramBytes)}</span>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">GPU info from API</span>
                <span className="max-w-[min(100%,24rem)] text-right font-medium">
                  {qStatus.data.gpu_info ?? '— (Ollama often omits GPU names in /api/ps)'}
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Hardware (known setup)</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-4 font-mono-ui text-xs leading-relaxed md:text-sm">
              {`sam-desktop — Windows 11
├── RTX 5090 — 32GB VRAM (GPU 0)
└── RTX 4080 Super — 16GB VRAM (GPU 1, pending setup)
Ollama: NSSM service at D:\\ollama\\ollama.exe`}
            </pre>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Environment variable config</h2>
        <p className="text-sm text-muted-foreground">
          Stored values drive the generated NSSM script. Defaults apply when a key is not saved yet.
        </p>

        {qConfig.isError && (
          <Card className="border-destructive/50 bg-destructive/10">
            <CardContent className="py-4 text-sm text-destructive">
              Could not load saved config (admin token required).
            </CardContent>
          </Card>
        )}

        <div className="space-y-4">
          <EnvRow
            label="CUDA_VISIBLE_DEVICES"
            draft={draft.CUDA_VISIBLE_DEVICES}
            stored={effective.CUDA_VISIBLE_DEVICES}
            defaultHint="0,1"
            explanation="Controls which GPUs Ollama uses and their order. 0 = RTX 5090 only. 0,1 = both. 1,0 = 4080 Super first."
            example="0,1"
            onDraft={(v) => setDraft((d) => ({ ...d, CUDA_VISIBLE_DEVICES: v }))}
            onSave={(v) => saveRow('CUDA_VISIBLE_DEVICES', v)}
            disabled={putMut.isPending}
          />
          <EnvRow
            label="OLLAMA_GPU_LAYERS"
            draft={draft.OLLAMA_GPU_LAYERS}
            stored={effective.OLLAMA_GPU_LAYERS}
            defaultHint="(empty = auto)"
            explanation="Number of layers to offload to GPU. Leave empty for automatic behavior. Useful for partial offload on very large models."
            example="32"
            onDraft={(v) => setDraft((d) => ({ ...d, OLLAMA_GPU_LAYERS: v }))}
            onSave={(v) => saveRow('OLLAMA_GPU_LAYERS', v)}
            disabled={putMut.isPending}
          />
          <div className="rounded-md border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="font-mono-ui text-sm">OLLAMA_MAX_LOADED_MODELS</Label>
              <span className="text-xs text-muted-foreground">default: 1 · range 1–8</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Max models loaded in VRAM at once. Use 2 to keep a 9B model on the 4080 Super while a larger model uses
              the 5090.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                type="number"
                min={1}
                max={8}
                value={draft.OLLAMA_MAX_LOADED_MODELS}
                onChange={(e) => setDraft((d) => ({ ...d, OLLAMA_MAX_LOADED_MODELS: e.target.value }))}
                className="font-mono-ui sm:max-w-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={putMut.isPending}
                onClick={() => {
                  const n = Number(draft.OLLAMA_MAX_LOADED_MODELS)
                  if (!Number.isInteger(n) || n < 1 || n > 8) return
                  saveRow('OLLAMA_MAX_LOADED_MODELS', String(n))
                }}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Stored: <span className="font-mono-ui">{effective.OLLAMA_MAX_LOADED_MODELS || '—'}</span>
            </p>
          </div>
          <EnvRow
            label="OLLAMA_KEEP_ALIVE"
            draft={draft.OLLAMA_KEEP_ALIVE}
            stored={effective.OLLAMA_KEEP_ALIVE}
            defaultHint="30m"
            explanation="How long a model stays in VRAM after last use. Formats: 30m, 1h, 0 (unload immediately), -1 (never unload)."
            example="30m"
            onDraft={(v) => setDraft((d) => ({ ...d, OLLAMA_KEEP_ALIVE: v }))}
            onSave={(v) => saveRow('OLLAMA_KEEP_ALIVE', v)}
            disabled={putMut.isPending}
          />
          <div className="rounded-md border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="font-mono-ui text-sm">OLLAMA_FLASH_ATTENTION</Label>
              <span className="text-xs text-muted-foreground">default: off · recommended: on</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Reduces VRAM usage with minimal quality impact when supported by the runtime.
            </p>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={draft.OLLAMA_FLASH_ATTENTION === '1'}
                onChange={(e) => {
                  const v = e.target.checked ? '1' : '0'
                  setDraft((d) => ({ ...d, OLLAMA_FLASH_ATTENTION: v }))
                }}
              />
              <span>Enable flash attention</span>
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={putMut.isPending}
              onClick={() => saveRow('OLLAMA_FLASH_ATTENTION', draft.OLLAMA_FLASH_ATTENTION === '1' ? '1' : '0')}
            >
              Save toggle
            </Button>
            <p className="text-xs text-muted-foreground">
              Stored:{' '}
              <span className="font-mono-ui">{effective.OLLAMA_FLASH_ATTENTION === '1' ? '1 (on)' : '0 (off)'}</span>
            </p>
          </div>
          <div className="rounded-md border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="font-mono-ui text-sm">OLLAMA_KV_CACHE_TYPE</Label>
              <span className="text-xs text-muted-foreground">default: f16</span>
            </div>
            <p className="text-sm text-muted-foreground">KV cache quantization (approximate VRAM for a 9B model @ 8K context).</p>
            <select
              className="flex h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm font-mono-ui"
              value={draft.OLLAMA_KV_CACHE_TYPE}
              onChange={(e) => setDraft((d) => ({ ...d, OLLAMA_KV_CACHE_TYPE: e.target.value }))}
            >
              <option value="f16">f16 — ~2GB KV @ 8K (estimate)</option>
              <option value="q8_0">q8_0 — ~1GB @ 8K (estimate) · recommended tradeoff</option>
              <option value="q4_0">q4_0 — ~500MB @ 8K (estimate) · max savings</option>
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={putMut.isPending}
              onClick={() => saveRow('OLLAMA_KV_CACHE_TYPE', draft.OLLAMA_KV_CACHE_TYPE)}
            >
              Save
            </Button>
            <p className="text-xs text-muted-foreground">
              Stored: <span className="font-mono-ui">{effective.OLLAMA_KV_CACHE_TYPE}</span>
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">KV cache types (reference)</CardTitle>
            <p className="text-xs font-normal text-amber-200/90">
              Figures below are rough estimates for discussion — not precise benchmarks.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 font-mono-ui text-xs leading-relaxed text-muted-foreground md:text-sm">
            <div>
              <p className="font-semibold text-foreground">f16 (default)</p>
              <p>Full precision KV cache. Best quality. Uses about 2 bytes per token per layer.</p>
            </div>
            <div>
              <p className="font-semibold text-foreground">q8_0 — recommended</p>
              <p>8-bit quantized KV cache. ~50% memory reduction vs f16. Minimal quality loss for most workloads.</p>
            </div>
            <div>
              <p className="font-semibold text-foreground">q4_0</p>
              <p>4-bit quantized KV cache. ~75% memory reduction vs f16. More noticeable quality loss on long contexts.</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Multi-GPU split strategy</h2>
        <div className="flex flex-col gap-4">
          {PRESETS.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="text-base">{p.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono-ui text-xs">{p.body}</pre>
                <p className="text-muted-foreground">{p.desc}</p>
                <Button
                  size="sm"
                  disabled={putMut.isPending || qConfig.isLoading}
                  onClick={() => applyPreset(p)}
                >
                  Apply preset (saves to SQLite)
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Apply changes on sam-desktop</h2>
          {pending ? (
            <Badge variant="amber">Pending changes</Badge>
          ) : (
            <Badge variant="secondary">In sync with last “applied” snapshot</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          After you run NSSM on sam-desktop, click “Mark as applied” so the dashboard reflects that the live service
          should match your stored values.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={copyScript}>
            <Copy className="mr-2 h-4 w-4" />
            Copy commands
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={appliedMut.isPending || qConfig.isLoading}
            onClick={() => appliedMut.mutate()}
          >
            {appliedMut.isPending ? 'Saving…' : 'Mark as applied'}
          </Button>
        </div>
        <Card>
          <CardContent className="p-0">
            <pre className="max-h-[28rem] overflow-auto overflow-x-auto rounded-md border border-border bg-muted/50 p-4 font-mono-ui text-[11px] leading-snug text-foreground md:text-xs">
              {script}
            </pre>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function EnvRow({
  label,
  draft,
  stored,
  defaultHint,
  explanation,
  example,
  onDraft,
  onSave,
  disabled,
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="font-mono-ui text-sm">{label}</Label>
        <span className="text-xs text-muted-foreground">default: {defaultHint}</span>
      </div>
      <p className="text-sm text-muted-foreground">{explanation}</p>
      <p className="text-xs text-muted-foreground">
        Example: <span className="font-mono-ui">{example}</span>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="text"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          className="font-mono-ui sm:max-w-lg"
          placeholder={defaultHint}
        />
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onSave(draft)}>
          Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Stored: <span className="font-mono-ui">{stored || '—'}</span>
      </p>
    </div>
  )
}
