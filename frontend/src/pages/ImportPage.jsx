import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { fetchHfRepoFiles, listModels, verifySamPath } from '@/api/ollama.js'
import { consumeModelsSsePost, fetchSshStatus } from '@/api/models.js'
import { ApplyTerminalPanel } from '@/components/ApplyTerminalPanel.jsx'
import { SshStatusIndicator } from '@/components/SshStatusIndicator.jsx'
import { Button } from '@/components/ui/button.jsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'
import { cn } from '@/lib/utils.js'
import {
  TEMPLATE_PRESETS,
  buildModelfileFromGuided,
  defaultGuidedState,
  getPreset,
} from '@/utils/modelfile.js'

const SAM_DESKTOP = '100.101.41.16'
const QUANT_OPTIONS = [
  {
    id: 'q4_K_M',
    title: 'q4_K_M',
    badge: 'Recommended',
    detail: '~5.6GB for 9B. Best balance of quality and size.',
  },
  {
    id: 'q4_K_S',
    title: 'q4_K_S',
    badge: 'Smaller',
    detail: '~5.3GB for 9B. Slightly lower quality.',
  },
  {
    id: 'q8_0',
    title: 'q8_0',
    badge: 'High quality',
    detail: '~9.5GB for 9B. Near full quality, larger file.',
  },
]

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

function pathBasename(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  const norm = s.replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

function looksLikeMmproj(pathOrName) {
  const b = pathBasename(pathOrName).toLowerCase()
  return b.includes('mmproj') || b.includes('vision')
}

function pathLooksAlreadyQuantized(p) {
  const b = pathBasename(p)
  if (!b) return false
  return /(?:^|[._-])(Q[2-8][^.\s]*|q[2-8]_[^.\s]*|IQ[0-9]|q\d+_[kK]_[sSmM])/i.test(b)
}

function parseQuantFromGgufFilename(name) {
  const base = name.replace(/\.gguf$/i, '')
  const m = base.match(
    /\b(Q[0-9][A-Za-z0-9_.-]*|q[0-9]+_[kK]_[sSmM]|IQ[0-9]+_[A-Za-z0-9_.-]*|F16|F32|fp16|fp32)\b/i
  )
  return m ? m[1] : '—'
}

function apiTemplateFromPreset(presetId) {
  if (presetId === 'llama3') return 'llama3'
  if (presetId === 'mistral') return 'mistral'
  return 'chatml'
}

function quantRowTone(label) {
  const u = String(label || '').toUpperCase()
  if (u.includes('Q4_K_M') || u === 'Q4_K_M') return 'text-emerald-400 font-medium'
  if (u.includes('Q8') || u.startsWith('Q8')) return 'text-sky-400 font-medium'
  if (/Q[23]|IQ[23]/i.test(u) || /^Q2|^Q3/i.test(u)) return 'text-amber-300 font-medium'
  return 'text-muted-foreground'
}

function QuantizeSection({
  enabled,
  onEnabledChange,
  choice,
  onChoiceChange,
  collapsibleOpen,
  onCollapsibleOpenChange,
}) {
  return (
    <Collapsible open={collapsibleOpen} onOpenChange={onCollapsibleOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-semibold hover:bg-accent/10">
        Quantization during import
        <span className="text-xs font-normal text-muted-foreground">
          {enabled ? 'On' : 'Off'} · {collapsibleOpen ? 'Hide' : 'Show'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-3 px-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="rounded border-border"
          />
          Quantize during import
        </label>
        {enabled && (
          <>
            <p className="text-xs text-muted-foreground">
              Only works on F16/F32 source models. Already-quantized GGUFs cannot be re-quantized.
            </p>
            <div className="space-y-2">
              {QUANT_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className={cn(
                    'flex cursor-pointer flex-col gap-0.5 rounded-md border border-border p-3 text-sm',
                    choice === opt.id && 'border-primary/60 bg-primary/5'
                  )}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="import-quant"
                      checked={choice === opt.id}
                      onChange={() => onChoiceChange(opt.id)}
                      className="border-border"
                    />
                    <span className="font-mono-ui font-medium">{opt.title}</span>
                    {opt.badge && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {opt.badge}
                      </span>
                    )}
                  </span>
                  <span className="pl-6 text-xs text-muted-foreground">{opt.detail}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ImportPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const qSsh = useQuery({
    queryKey: ['ssh-status'],
    queryFn: fetchSshStatus,
    refetchInterval: 30_000,
    retry: false,
  })
  const sshBlocked = qSsh.data?.connected === false
  const sshBlockTitle = 'sam-desktop unreachable via SSH'

  const [mainTab, setMainTab] = useState('gguf')

  const [ggufPath, setGgufPath] = useState('')
  const [safetensorsPath, setSafetensorsPath] = useState('')
  const [loraMode, setLoraMode] = useState(false)
  const [loraBase, setLoraBase] = useState('')

  const [guided, setGuided] = useState(() => defaultGuidedState())
  const [systemOpen, setSystemOpen] = useState(false)

  const [quantOpen, setQuantOpen] = useState(false)
  const [quantizeEnabled, setQuantizeEnabled] = useState(false)
  const [quantChoice, setQuantChoice] = useState('q4_K_M')

  const [modelNameGguf, setModelNameGguf] = useState('')
  const [modelNameSafe, setModelNameSafe] = useState('')

  const [creating, setCreating] = useState(false)

  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalLines, setTerminalLines] = useState([])
  const [terminalRunning, setTerminalRunning] = useState(false)
  const [terminalResult, setTerminalResult] = useState(null)
  const [pullProgress, setPullProgress] = useState(null)

  const [ggufVerify, setGgufVerify] = useState(null)
  const [safeVerify, setSafeVerify] = useState(null)
  const [verifyGgufBusy, setVerifyGgufBusy] = useState(false)
  const [verifySafeBusy, setVerifySafeBusy] = useState(false)

  const [hfRepoInput, setHfRepoInput] = useState('')
  const [hfLookupLoading, setHfLookupLoading] = useState(false)
  const [hfError, setHfError] = useState('')
  const [hfData, setHfData] = useState(null)

  const [hfPullName, setHfPullName] = useState('')
  const [hfSelectedFile, setHfSelectedFile] = useState('')
  const [hfCreateName, setHfCreateName] = useState('')

  const { data: tags } = useQuery({
    queryKey: ['ollama', 'models'],
    queryFn: listModels,
  })

  const modelOptions = useMemo(() => {
    const m = tags?.models
    if (!Array.isArray(m)) return []
    return m.map((x) => x.name || x.model).filter(Boolean)
  }, [tags])

  const applyPreset = (presetId) => {
    const p = getPreset(presetId)
    setGuided((g) => ({
      ...g,
      templatePreset: presetId,
      templateRaw: p.id === 'raw' ? g.templateRaw : '',
      stops:
        p.stops?.length && presetId !== 'raw' && presetId !== 'auto'
          ? [...new Set([...g.stops, ...p.stops])]
          : g.stops,
    }))
  }

  const ggufModelfile = useMemo(() => {
    const g = {
      ...guided,
      fromMode: 'custom',
      fromCustom: ggufPath.trim(),
      adapter: '',
    }
    return buildModelfileFromGuided(g)
  }, [guided, ggufPath])

  const safeModelfile = useMemo(() => {
    if (loraMode) {
      const g = {
        ...guided,
        fromMode: 'pick',
        fromSelect: loraBase.trim(),
        fromCustom: '',
        adapter: safetensorsPath.trim(),
      }
      return buildModelfileFromGuided(g)
    }
    const g = {
      ...guided,
      fromMode: 'custom',
      fromCustom: safetensorsPath.trim(),
      adapter: '',
    }
    return buildModelfileFromGuided(g)
  }, [guided, safetensorsPath, loraMode, loraBase])

  const pullCreateStops = useMemo(() => {
    const preset = getPreset(guided.templatePreset)
    const base = [...(preset.stops || []), ...(guided.stops || [])]
    return [...new Set(base.map((s) => String(s).trim()).filter(Boolean))]
  }, [guided.templatePreset, guided.stops])

  const runVerifyGguf = async () => {
    const p = ggufPath.trim()
    if (!p) return
    setVerifyGgufBusy(true)
    setGgufVerify(null)
    try {
      const r = await verifySamPath(p)
      setGgufVerify(r)
    } catch (e) {
      setGgufVerify({ exists: false, error: e.message || 'verify failed' })
    } finally {
      setVerifyGgufBusy(false)
    }
  }

  const runVerifySafe = async () => {
    const p = safetensorsPath.trim()
    if (!p) return
    setVerifySafeBusy(true)
    setSafeVerify(null)
    try {
      const r = await verifySamPath(p)
      setSafeVerify(r)
    } catch (e) {
      setSafeVerify({ exists: false, error: e.message || 'verify failed' })
    } finally {
      setVerifySafeBusy(false)
    }
  }

  const runCreate = async (name, modelfile, _tabLabel) => {
    const n = name.trim()
    if (!n) return
    if (!modelfile.trim()) {
      setTerminalOpen(true)
      setTerminalLines(['Modelfile is empty — check path and options.'])
      setTerminalResult('failed')
      return
    }
    if (sshBlocked) return

    const quant = quantizeEnabled ? quantChoice : null
    setCreating(true)
    setTerminalLines([])
    setTerminalResult(null)
    setTerminalOpen(true)
    setTerminalRunning(true)
    let sawDone = false
    let sawErr = false
    try {
      await consumeModelsSsePost(
        '/api/ollama/create-quantized',
        { name: n, modelfile, quantize: quant },
        (ev) => {
          if (ev.type === 'log' && ev.line != null) {
            setTerminalLines((prev) => [...prev, String(ev.line)])
          }
          if (ev.type === 'error') {
            sawErr = true
            setTerminalLines((prev) => [...prev, ev.message || 'Error'])
            setTerminalResult('failed')
          }
          if (ev.type === 'done' && ev.success) {
            sawDone = true
            setTerminalResult('success')
            qc.invalidateQueries({ queryKey: ['ollama', 'models'] })
          }
        },
        undefined
      )
      if (!sawDone && !sawErr) {
        setTerminalLines((prev) => [...prev, 'Stream ended without completion'])
        setTerminalResult('failed')
      }
      if (sawDone) navigate('/models')
    } catch (e) {
      setTerminalLines((prev) => [...prev, e.message || 'Import failed'])
      setTerminalResult('failed')
    } finally {
      setTerminalRunning(false)
      setCreating(false)
    }
  }

  const onHfLookup = async () => {
    const repo = hfRepoInput.trim().replace(/^\/+/, '')
    if (!repo) return
    setHfError('')
    setHfData(null)
    setHfSelectedFile('')
    setHfPullName('')
    setHfCreateName('')
    setHfLookupLoading(true)
    try {
      const data = await fetchHfRepoFiles(repo)
      if (data?.error) {
        setHfError(data.error === 'repo not found' ? 'Repo not found.' : data.error)
        return
      }
      setHfData(data)
    } catch (e) {
      setHfError(e.message || 'Lookup failed')
    } finally {
      setHfLookupLoading(false)
    }
  }

  const normalizedRepo = useMemo(() => {
    const r = hfRepoInput.trim().replace(/^\/+/, '')
    return r
  }, [hfRepoInput])

  const selectHfFile = (fileName) => {
    setHfSelectedFile(fileName)
    const stem = fileName.replace(/\.gguf$/i, '')
    if (normalizedRepo) setHfPullName(`hf.co/${normalizedRepo}:${stem}`)
    setHfCreateName((prev) => {
      if (prev.trim()) return prev
      const leaf = fileName.split('/').pop() || fileName
      const s = leaf.replace(/\.gguf$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64)
      return s || 'imported-model'
    })
  }

  const effectiveHfRef = useMemo(() => {
    const r = hfPullName.trim()
    if (!r) return ''
    return r.toLowerCase().startsWith('hf.co/') ? r : `hf.co/${r.replace(/^\/*/, '')}`
  }, [hfPullName])

  const startHfPullAndCreate = async () => {
    const ref = effectiveHfRef
    const n = hfCreateName.trim()
    if (!ref || !n || sshBlocked) return
    setCreating(true)
    setTerminalLines([])
    setTerminalResult(null)
    setPullProgress(null)
    setTerminalOpen(true)
    setTerminalRunning(true)
    let sawDone = false
    let sawErr = false
    try {
      await consumeModelsSsePost(
        '/api/models/pull-and-create',
        {
          hf_ref: ref,
          name: n,
          template: apiTemplateFromPreset(guided.templatePreset),
          parameters: {
            temperature: guided.params.temperature,
            top_p: guided.params.top_p,
            top_k: guided.params.top_k,
            repeat_penalty: guided.params.repeat_penalty,
            num_ctx: guided.params.num_ctx,
            stop: pullCreateStops,
          },
        },
        (ev) => {
          if (ev.type === 'progress') {
            const t = ev.total ? Math.round((ev.completed / ev.total) * 100) : 0
            setPullProgress({ status: String(ev.status ?? ''), pct: t })
            return
          }
          if (ev.type === 'log' && ev.line != null) {
            setTerminalLines((prev) => [...prev, String(ev.line)])
          }
          if (ev.type === 'error') {
            sawErr = true
            setPullProgress(null)
            setTerminalLines((prev) => [...prev, ev.message || 'Error'])
            setTerminalResult('failed')
          }
          if (ev.type === 'done' && ev.success) {
            sawDone = true
            setPullProgress(null)
            setTerminalResult('success')
            qc.invalidateQueries({ queryKey: ['ollama', 'models'] })
          }
        },
        undefined
      )
      if (!sawDone && !sawErr) {
        setTerminalLines((prev) => [...prev, 'Stream ended without completion'])
        setTerminalResult('failed')
      }
      if (sawDone) navigate('/models')
    } catch (e) {
      setTerminalLines((prev) => [...prev, e.message || 'Pull & create failed'])
      setTerminalResult('failed')
    } finally {
      setPullProgress(null)
      setTerminalRunning(false)
      setCreating(false)
    }
  }

  const samNote = (
    <p className="text-xs text-muted-foreground">
      Paths must exist on <strong className="text-foreground">sam-desktop</strong> (Ollama host{' '}
      <code className="font-mono-ui">{SAM_DESKTOP}</code>), not inside Docker on the homelab server.
    </p>
  )

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-32">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/models">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">Import Model</h1>
        <SshStatusIndicator className="ml-auto" />
      </div>

      {sshBlocked && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          SSH to sam-desktop failed. Path checks and imports run on the Windows host — enable SSH or fix keys, then
          retry.
        </div>
      )}

      {samNote}

      <select
        className="md:hidden flex h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none ring-ring focus-visible:ring-2"
        value={mainTab}
        onChange={(e) => setMainTab(e.target.value)}
        aria-label="Import method"
      >
        <option value="gguf">GGUF file</option>
        <option value="safetensors">Safetensors directory</option>
        <option value="huggingface">HuggingFace</option>
      </select>

      <Tabs value={mainTab} onValueChange={setMainTab}>
        <TabsList className="hidden md:flex w-full flex-wrap h-auto gap-1">
          <TabsTrigger value="gguf" className="flex-1">
            GGUF file
          </TabsTrigger>
          <TabsTrigger value="safetensors" className="flex-1">
            Safetensors directory
          </TabsTrigger>
          <TabsTrigger value="huggingface" className="flex-1">
            HuggingFace
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gguf" className="space-y-4 mt-6">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            The path must be readable by Ollama on sam-desktop. Docker or homelab paths will not work.
          </div>
          <div className="space-y-2">
            <Label>Path to GGUF file on sam-desktop</Label>
            <Input
              className="font-mono-ui text-sm"
              placeholder={`D:\\mymodels\\model.gguf`}
              value={ggufPath}
              onChange={(e) => setGgufPath(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Full Windows path, e.g. <code className="font-mono-ui">D:\ollama models\blobs\sha256-…</code> or{' '}
              <code className="font-mono-ui">D:\mymodels\llama.gguf</code>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={runVerifyGguf}
                disabled={verifyGgufBusy || !ggufPath.trim() || sshBlocked}
                title={sshBlocked ? sshBlockTitle : undefined}
              >
                {verifyGgufBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                Verify path
              </Button>
              {ggufVerify && !ggufVerify.error && (
                <span className="text-xs text-muted-foreground">
                  {ggufVerify.exists
                    ? `✓ Exists${ggufVerify.is_file ? ' (file)' : ggufVerify.is_dir ? ' (dir)' : ''}`
                    : '✗ Not found'}
                </span>
              )}
              {ggufVerify?.error && (
                <span className="text-xs text-destructive">✗ {ggufVerify.error}</span>
              )}
            </div>
          </div>
          {looksLikeMmproj(ggufPath) && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              This looks like a vision projector blob. Import only the text GGUF, not the mmproj file.
            </div>
          )}
          {pathLooksAlreadyQuantized(ggufPath) && quantizeEnabled && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              This filename looks already quantized. Re-quantizing usually fails or is unnecessary — use an F16/F32
              source or turn off quantize.
            </div>
          )}
          <div className="space-y-1">
            <Label>Template</Label>
            <select
              className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none ring-ring focus-visible:ring-2"
              value={guided.templatePreset}
              onChange={(e) => applyPreset(e.target.value)}
            >
              {TEMPLATE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{getPreset(guided.templatePreset).description}</p>
          </div>
          {guided.templatePreset === 'raw' && (
            <div>
              <Label>Custom template</Label>
              <Textarea
                value={guided.templateRaw}
                onChange={(e) => setGuided((g) => ({ ...g, templateRaw: e.target.value }))}
                className="mt-1 min-h-[120px] font-mono-ui text-xs"
              />
            </div>
          )}
          <Collapsible open={systemOpen} onOpenChange={setSystemOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-semibold hover:bg-accent/10">
              Optional system prompt
              <span className="text-xs font-normal text-muted-foreground">{systemOpen ? 'Hide' : 'Show'}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <Textarea
                value={guided.system}
                onChange={(e) => setGuided((g) => ({ ...g, system: e.target.value }))}
                className="min-h-[100px]"
                placeholder="Optional SYSTEM block…"
              />
            </CollapsibleContent>
          </Collapsible>
          <QuantizeSection
            enabled={quantizeEnabled}
            onEnabledChange={setQuantizeEnabled}
            choice={quantChoice}
            onChoiceChange={setQuantChoice}
            collapsibleOpen={quantOpen}
            onCollapsibleOpenChange={setQuantOpen}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1">
              <Label>New model name</Label>
              <Input
                className="font-mono-ui"
                value={modelNameGguf}
                onChange={(e) => setModelNameGguf(e.target.value)}
                placeholder="my-imported-model"
              />
            </div>
            <Button
              onClick={() => runCreate(modelNameGguf, ggufModelfile, 'Import')}
              disabled={creating || !modelNameGguf.trim() || !ggufPath.trim() || sshBlocked}
              title={sshBlocked ? sshBlockTitle : undefined}
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Import via SSH
            </Button>
          </div>
          {pathLooksAlreadyQuantized(ggufPath) && !quantizeEnabled && (
            <p className="text-xs text-amber-200/90">
              Filename suggests this may already be quantized. Quantize-during-import needs an F16/F32 source.
            </p>
          )}
        </TabsContent>

        <TabsContent value="safetensors" className="space-y-4 mt-6">
          <div className="rounded-md border border-border bg-card/50 px-3 py-2 text-xs font-mono-ui leading-relaxed text-muted-foreground">
            <div className="font-sans font-semibold text-foreground mb-1">Supported architectures</div>✓ Llama (1, 2,
            3, 3.1, 3.2)
            <br />✓ Mistral (1, 2, Mixtral)
            <br />✓ Gemma (1, 2)
            <br />✓ Phi3
          </div>
          <div className="space-y-2">
            <Label>Path to Safetensors directory on sam-desktop</Label>
            <Input
              className="font-mono-ui text-sm"
              placeholder={`D:\\models\\my-model-safetensors`}
              value={safetensorsPath}
              onChange={(e) => setSafetensorsPath(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Directory must contain model weights in .safetensors format.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={runVerifySafe}
                disabled={verifySafeBusy || !safetensorsPath.trim() || sshBlocked}
                title={sshBlocked ? sshBlockTitle : undefined}
              >
                {verifySafeBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                Verify path
              </Button>
              {safeVerify && !safeVerify.error && (
                <span className="text-xs text-muted-foreground">
                  {safeVerify.exists
                    ? `✓ Exists${safeVerify.is_dir ? ' (dir)' : safeVerify.is_file ? ' (file)' : ''}`
                    : '✗ Not found'}
                </span>
              )}
              {safeVerify?.error && <span className="text-xs text-destructive">✗ {safeVerify.error}</span>}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={loraMode}
              onChange={(e) => {
                setLoraMode(e.target.checked)
                if (!e.target.checked) setLoraBase('')
              }}
              className="rounded border-border"
            />
            This is a LoRA adapter (not a full model)
          </label>
          {loraMode && (
            <div className="space-y-1">
              <Label>Base model (local)</Label>
              <select
                className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none ring-ring focus-visible:ring-2"
                value={loraBase}
                onChange={(e) => setLoraBase(e.target.value)}
              >
                <option value="">Select base model…</option>
                {modelOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Adapters must match the base model&apos;s architecture exactly.
              </p>
            </div>
          )}
          {pathLooksAlreadyQuantized(safetensorsPath) && quantizeEnabled && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              Path name suggests weights may already be quantized. Quantize-on-import needs F16/F32 sources.
            </div>
          )}
          <div className="space-y-1">
            <Label>Template</Label>
            <select
              className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none ring-ring focus-visible:ring-2"
              value={guided.templatePreset}
              onChange={(e) => applyPreset(e.target.value)}
            >
              {TEMPLATE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {guided.templatePreset === 'raw' && (
            <div>
              <Label>Custom template</Label>
              <Textarea
                value={guided.templateRaw}
                onChange={(e) => setGuided((g) => ({ ...g, templateRaw: e.target.value }))}
                className="mt-1 min-h-[120px] font-mono-ui text-xs"
              />
            </div>
          )}
          <Collapsible open={systemOpen} onOpenChange={setSystemOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-semibold hover:bg-accent/10">
              Optional system prompt
              <span className="text-xs font-normal text-muted-foreground">{systemOpen ? 'Hide' : 'Show'}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <Textarea
                value={guided.system}
                onChange={(e) => setGuided((g) => ({ ...g, system: e.target.value }))}
                className="min-h-[100px]"
              />
            </CollapsibleContent>
          </Collapsible>
          <QuantizeSection
            enabled={quantizeEnabled}
            onEnabledChange={setQuantizeEnabled}
            choice={quantChoice}
            onChoiceChange={setQuantChoice}
            collapsibleOpen={quantOpen}
            onCollapsibleOpenChange={setQuantOpen}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1">
              <Label>New model name</Label>
              <Input
                className="font-mono-ui"
                value={modelNameSafe}
                onChange={(e) => setModelNameSafe(e.target.value)}
                placeholder="my-safetensors-model"
              />
            </div>
            <Button
              onClick={() => runCreate(modelNameSafe, safeModelfile, 'Import')}
              disabled={
                creating ||
                !modelNameSafe.trim() ||
                !safetensorsPath.trim() ||
                (loraMode && !loraBase.trim()) ||
                sshBlocked
              }
              title={sshBlocked ? sshBlockTitle : undefined}
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Import via SSH
            </Button>
          </div>
          {pathLooksAlreadyQuantized(safetensorsPath) && !quantizeEnabled && (
            <p className="text-xs text-amber-200/90">
              Path name may indicate already-quantized weights. Enable quantize only for F16/F32 sources.
            </p>
          )}
        </TabsContent>

        <TabsContent value="huggingface" className="space-y-4 mt-6">
          <div className="rounded-md border border-border/80 bg-muted/20 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
            ℹ️ HF models tagged as multimodal will pull a vision projector, causing a double FROM and a 500 on load. Use
            Pull &amp; Create below (same flow as the Models page) — it strips the projector and applies the template.
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1">
              <Label>HuggingFace repo</Label>
              <Input
                className="font-mono-ui text-sm"
                placeholder="org/repo-name"
                value={hfRepoInput}
                onChange={(e) => setHfRepoInput(e.target.value)}
              />
            </div>
            <Button type="button" variant="secondary" onClick={onHfLookup} disabled={hfLookupLoading || !hfRepoInput.trim()}>
              {hfLookupLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              Look up
            </Button>
          </div>
          {hfError && <p className="text-sm text-destructive">{hfError}</p>}
          {hfData && (
            <div className="space-y-3 rounded-md border border-border bg-card/40 p-3">
              <div className="text-sm">
                <div className="font-semibold text-foreground mb-2">Repo metadata</div>
                <dl className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">Architecture</dt>
                    <dd>{hfData.metadata?.architecture ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Parameter size</dt>
                    <dd>{hfData.metadata?.parameter_size ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">License</dt>
                    <dd className="break-all">{hfData.metadata?.license ?? '—'}</dd>
                  </div>
                </dl>
              </div>
              {hfData.files?.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="py-2 pr-2">File</th>
                        <th className="py-2 pr-2">Size</th>
                        <th className="py-2 pr-2">Quant (guess)</th>
                        <th className="py-2 w-[72px]" />
                      </tr>
                    </thead>
                    <tbody>
                      {hfData.files.map((f) => {
                        const q = parseQuantFromGgufFilename(f.name)
                        return (
                          <tr key={f.name} className="border-b border-border/60">
                            <td className="py-2 pr-2 font-mono-ui break-all">{f.name}</td>
                            <td className="py-2 pr-2 whitespace-nowrap">{formatBytes(f.size)}</td>
                            <td className={cn('py-2 pr-2', quantRowTone(q))}>{q}</td>
                            <td className="py-2">
                              <Button type="button" size="sm" variant="outline" onClick={() => selectHfFile(f.name)}>
                                Select
                              </Button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No .gguf files listed for this repo.</p>
              )}
            </div>
          )}
          <div className="space-y-1">
            <Label>Pull reference</Label>
            <Input
              className="font-mono-ui text-sm"
              value={hfPullName}
              onChange={(e) => setHfPullName(e.target.value)}
              placeholder="hf.co/user/repo:quant-or-stem"
            />
            <p className="text-xs text-muted-foreground">
              Pulled blobs are already quantized. Pull &amp; Create rewrites the Modelfile via SSH on sam-desktop.
            </p>
          </div>
          <div className="space-y-1">
            <Label>New model name</Label>
            <Input
              className="font-mono-ui text-sm"
              value={hfCreateName}
              onChange={(e) => setHfCreateName(e.target.value)}
              placeholder="my-local-name"
            />
          </div>
          {hfSelectedFile && looksLikeMmproj(hfSelectedFile) && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              ⚠️ This is a vision projector file. Pulling it alongside the text model will cause a 500 error in Ollama.
              Select the text-only GGUF instead.
            </div>
          )}
          <Button
            onClick={startHfPullAndCreate}
            disabled={creating || !effectiveHfRef || !hfCreateName.trim() || sshBlocked}
            title={sshBlocked ? sshBlockTitle : undefined}
          >
            {creating && <Loader2 className="h-4 w-4 animate-spin" />}
            Pull &amp; Create via SSH
          </Button>
        </TabsContent>
      </Tabs>

      <ApplyTerminalPanel
        open={terminalOpen}
        onClose={() => {
          setTerminalOpen(false)
          setTerminalLines([])
          setTerminalResult(null)
          setPullProgress(null)
        }}
        lines={terminalLines}
        running={terminalRunning}
        result={terminalResult}
        pullProgress={pullProgress}
      />
    </div>
  )
}
