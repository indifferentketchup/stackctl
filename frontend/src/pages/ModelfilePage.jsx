import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { listModels, showModel } from '@/api/ollama.js'
import { consumeModelsSsePost } from '@/api/models.js'
import { ApplyTerminalPanel } from '@/components/ApplyTerminalPanel.jsx'
import { SshStatusIndicator } from '@/components/SshStatusIndicator.jsx'
import { Button } from '@/components/ui/button.jsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.jsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'
import { cn } from '@/lib/utils.js'
import {
  TEMPLATE_PRESETS,
  buildModelfileFromGuided,
  defaultGuidedState,
  formatModelfileText,
  getPreset,
  highlightModelfileLine,
  parseModelfileToGuided,
  validateRawModelfile,
} from '@/utils/modelfile.js'

const SAMPLE_SYSTEM = `You are a concise, accurate assistant. Answer clearly, admit when you do not know, and follow user instructions.`

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-semibold hover:bg-accent/10">
        {title}
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-3 px-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

export function ModelfilePage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { name: routeName } = useParams()
  const isCreate = !routeName
  const decodedName = routeName ? decodeURIComponent(routeName) : ''

  const [tab, setTab] = useState('guided')
  const [guided, setGuided] = useState(() => defaultGuidedState())
  const [rawText, setRawText] = useState('')
  const [rawErrors, setRawErrors] = useState([])
  const [syncNote, setSyncNote] = useState(null)
  const [modelName, setModelName] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [createStatus, setCreateStatus] = useState('')
  const [creating, setCreating] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalLines, setTerminalLines] = useState([])
  const [terminalRunning, setTerminalRunning] = useState(false)
  const [terminalResult, setTerminalResult] = useState(null)
  const [dragMsg, setDragMsg] = useState(null)

  const { data: tags } = useQuery({
    queryKey: ['ollama', 'models'],
    queryFn: listModels,
  })

  const modelOptions = useMemo(() => {
    const m = tags?.models
    if (!Array.isArray(m)) return []
    return m.map((x) => x.name || x.model).filter(Boolean)
  }, [tags])

  const { data: showData, isLoading: showLoading } = useQuery({
    queryKey: ['ollama', 'show', decodedName],
    queryFn: () => showModel(decodedName),
    enabled: !isCreate && !!decodedName,
  })

  useEffect(() => {
    if (isCreate) {
      setModelName('')
      return
    }
    setModelName(decodedName)
  }, [isCreate, decodedName])

  useEffect(() => {
    if (!showData?.modelfile) return
    const text = String(showData.modelfile)
    setRawText(text)
    const { state, unknownInstructionCount } = parseModelfileToGuided(text)
    setGuided((g) => ({ ...g, ...state }))
    setSyncNote(
      unknownInstructionCount > 0
        ? `${unknownInstructionCount} unknown instruction(s) preserved in raw mode only`
        : null,
    )
  }, [showData])

  const built = useMemo(() => buildModelfileFromGuided(guided), [guided])

  useEffect(() => {
    if (tab === 'guided') setRawText(built)
  }, [built, tab])

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

  const onTabSwitch = (v) => {
    if (v === 'raw' && tab === 'guided') {
      setRawText(buildModelfileFromGuided(guided))
    }
    if (v === 'guided' && tab === 'raw') {
      const { state, unknownInstructionCount } = parseModelfileToGuided(rawText)
      setGuided((g) => ({ ...g, ...state }))
      setSyncNote(
        unknownInstructionCount > 0
          ? `${unknownInstructionCount} unknown instruction(s) preserved in raw mode only`
          : null,
      )
    }
    setTab(v)
  }

  const finalizeModelfile = () => (tab === 'guided' ? built : rawText)

  const runSshApply = async (navigateAfter) => {
    const mf = finalizeModelfile()
    const n = modelName.trim()
    if (!n) return
    setCreating(true)
    setTerminalLines([])
    setTerminalResult(null)
    setTerminalOpen(true)
    setTerminalRunning(true)
    setCreateStatus('Applying over SSH…')
    let sawDone = false
    let sawErr = false
    try {
      await consumeModelsSsePost(
        '/api/models/apply',
        { name: n, modelfile: mf, overwrite: true },
        (ev) => {
          if (ev.type === 'log' && ev.line != null) {
            setTerminalLines((prev) => [...prev, String(ev.line)])
          }
          if (ev.type === 'error') {
            sawErr = true
            setTerminalLines((prev) => [...prev, ev.message || 'Error'])
            setTerminalResult('failed')
            setCreateStatus(ev.message || 'Failed')
          }
          if (ev.type === 'done' && ev.success) {
            sawDone = true
            setTerminalResult('success')
            setCreateStatus('Success')
            qc.invalidateQueries({ queryKey: ['ollama', 'models'] })
            qc.refetchQueries({ queryKey: ['ollama', 'show', n] })
            if (navigateAfter) navigate('/models')
          }
        },
        undefined,
      )
      if (!sawDone && !sawErr) {
        setTerminalLines((prev) => [...prev, 'Stream ended without completion'])
        setTerminalResult('failed')
        setCreateStatus('Failed')
      }
    } catch (e) {
      const msg = e.message || 'Failed'
      setTerminalLines((prev) => [...prev, msg])
      setTerminalResult('failed')
      setCreateStatus(msg)
    } finally {
      setTerminalRunning(false)
      setCreating(false)
    }
  }

  const runCreate = () => runSshApply(true)

  const copyPreview = async () => {
    await navigator.clipboard.writeText(finalizeModelfile())
  }

  const suggestStops = () => {
    const p = getPreset(guided.templatePreset)
    if (p.stops?.length)
      setGuided((g) => ({ ...g, stops: [...new Set([...g.stops, ...p.stops])] }))
  }

  const moveMessage = (from, to) => {
    if (from == null || to == null || from === to) return
    setGuided((g) => {
      const arr = [...g.messages]
      const [sp] = arr.splice(from, 1)
      arr.splice(to, 0, sp)
      return { ...g, messages: arr }
    })
  }

  const rawLines = rawText.split('\n')

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-28">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/models">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <h1 className="text-2xl font-bold">
              {isCreate ? 'Create Model' : `Edit Model: ${decodedName}`}
            </h1>
            <SshStatusIndicator className="shrink-0" />
          </div>
          {!isCreate && showLoading && (
            <p className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading modelfile…
            </p>
          )}
        </div>
      </div>

      {syncNote && (
        <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {syncNote}
        </div>
      )}

      <Tabs value={tab} onValueChange={onTabSwitch}>
        <TabsList>
          <TabsTrigger value="guided">Guided</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>
        <TabsContent value="guided" className="space-y-6">
          <Section title="1. Base model (FROM)">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <Label>Local model</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none ring-ring focus-visible:ring-2"
                  value={guided.fromMode === 'pick' ? guided.fromSelect : ''}
                  onChange={(e) =>
                    setGuided((g) => ({
                      ...g,
                      fromMode: 'pick',
                      fromSelect: e.target.value,
                    }))
                  }
                >
                  <option value="">Select…</option>
                  {modelOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                type="button"
                variant={guided.fromMode === 'custom' ? 'secondary' : 'outline'}
                size="sm"
                onClick={() =>
                  setGuided((g) => ({ ...g, fromMode: g.fromMode === 'custom' ? 'pick' : 'custom' }))
                }
                className="shrink-0"
              >
                Custom path / HF
              </Button>
            </div>
            {guided.fromMode === 'custom' && (
              <div>
                <Label>FROM value</Label>
                <Input
                  className="mt-1 font-mono-ui text-sm"
                  placeholder="/path/model.gguf or hf.co/user/repo:Q4_K_M"
                  value={guided.fromCustom}
                  onChange={(e) => setGuided((g) => ({ ...g, fromCustom: e.target.value }))}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Use an existing local model, a GGUF file path, or a HuggingFace reference like{' '}
              <code className="font-mono-ui">hf.co/user/repo:Q4_K_M</code>
            </p>
          </Section>

          <Section title="2. System prompt (SYSTEM)">
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="outline" onClick={() => setGuided((g) => ({ ...g, system: SAMPLE_SYSTEM }))}>
                Example
              </Button>
            </div>
            <Textarea
              value={guided.system}
              onChange={(e) => setGuided((g) => ({ ...g, system: e.target.value }))}
              className="min-h-[140px]"
            />
            <p className="text-xs text-muted-foreground text-right">{guided.system.length} chars</p>
            <p className="text-xs text-muted-foreground mt-1">
              Sets the default behavior/personality. Can be overridden per-chat.
            </p>
          </Section>

          <Section title="3. Chat template (TEMPLATE)">
            <div className="space-y-1">
              <Label>Preset</Label>
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
              <p className="text-xs text-muted-foreground mt-1">
                {getPreset(guided.templatePreset).description}
              </p>
            </div>
            {guided.templatePreset === 'raw' && (
              <div>
                <Label>Template text</Label>
                <Textarea
                  value={guided.templateRaw}
                  onChange={(e) => setGuided((g) => ({ ...g, templateRaw: e.target.value }))}
                  className="mt-1 min-h-[160px] font-mono-ui text-xs"
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Must match the model&apos;s expected format. Wrong template = garbage output.
            </p>
          </Section>

          <Section title="4. Parameters">
            {[
              {
                k: 'temperature',
                label: 'temperature',
                min: 0,
                max: 2,
                step: 0.05,
                desc: 'Higher = more creative, lower = more focused. Recommended: 0.6–0.8',
                def: '—',
              },
              {
                k: 'top_k',
                label: 'top_k',
                min: 1,
                max: 200,
                step: 1,
                desc: 'Limits token pool size. Lower = more predictable. Default: 40',
                def: '40',
              },
              {
                k: 'top_p',
                label: 'top_p',
                min: 0,
                max: 1,
                step: 0.05,
                desc: 'Nucleus sampling. Works with top_k. Default: 0.9',
                def: '0.9',
              },
              {
                k: 'min_p',
                label: 'min_p',
                min: 0,
                max: 0.2,
                step: 0.01,
                desc: 'Minimum token probability relative to top token. Default: 0.0',
                def: '0.0',
              },
              {
                k: 'repeat_penalty',
                label: 'repeat_penalty',
                min: 0.5,
                max: 2,
                step: 0.05,
                desc: 'Penalizes repeated tokens. 1.0 = no penalty.',
                def: '1.0',
              },
            ].map((row) => (
              <div key={row.k} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <Label>{row.label}</Label>
                  <span className="text-muted-foreground">{guided.params[row.k]}</span>
                </div>
                <input
                  type="range"
                  min={row.min}
                  max={row.max}
                  step={row.step}
                  value={guided.params[row.k]}
                  onChange={(e) =>
                    setGuided((g) => ({
                      ...g,
                      params: { ...g.params, [row.k]: parseFloat(e.target.value) },
                    }))
                  }
                  className="w-full accent-primary"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {row.desc} <span className="opacity-70">Default: {row.def}</span>
                </p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground mt-1">
              Context window is set per-request in boolab DAW settings, not in the Modelfile.
            </p>
            {[
              { k: 'num_predict', label: 'num_predict', min: -1, max: 8192, step: 1 },
              { k: 'repeat_last_n', label: 'repeat_last_n', min: -1, max: 512, step: 1 },
              { k: 'seed', label: 'seed', min: 0, max: 99999, step: 1 },
            ].map((row) => (
              <div key={row.k} className="space-y-1">
                <Label>{row.label}</Label>
                <Input
                  type="number"
                  min={row.min}
                  max={row.max}
                  step={row.step}
                  value={guided.params[row.k]}
                  onChange={(e) =>
                    setGuided((g) => ({
                      ...g,
                      params: { ...g.params, [row.k]: parseInt(e.target.value, 10) || 0 },
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {row.k === 'num_predict' && 'Max tokens to generate. -1 = unlimited.'}
                  {row.k === 'repeat_last_n' && 'How far back to check for repeats. -1 = full context.'}
                  {row.k === 'seed' && 'Fixed seed for reproducibility. 0 = random.'}
                </p>
              </div>
            ))}
          </Section>

          <Section title="5. Stop tokens">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={suggestStops}>
                Add preset stops
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setGuided((g) => ({ ...g, stops: [...g.stops, ''] }))}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>
            {guided.stops.map((s, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={s}
                  onChange={(e) =>
                    setGuided((g) => {
                      const next = [...g.stops]
                      next[i] = e.target.value
                      return { ...g, stops: next }
                    })
                  }
                  className="font-mono-ui text-sm"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    setGuided((g) => ({ ...g, stops: g.stops.filter((_, j) => j !== i) }))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground mt-1">
              Model stops generating when it hits any of these strings.
            </p>
          </Section>

          <Section title="6. LoRA adapter (ADAPTER)">
            <Input
              value={guided.adapter}
              onChange={(e) => setGuided((g) => ({ ...g, adapter: e.target.value }))}
              className="font-mono-ui text-sm"
              placeholder="/absolute/path/to/adapter"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Absolute path to a GGUF or Safetensors LoRA adapter. Must match the base model&apos;s
              architecture.
            </p>
          </Section>

          <Section title="7. Few-shot messages (MESSAGE)">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setGuided((g) => ({
                  ...g,
                  messages: [...g.messages, { role: 'user', content: '' }],
                }))
              }
            >
              <Plus className="h-4 w-4" />
              Add turn
            </Button>
            {guided.messages.map((msg, i) => (
              <div
                key={i}
                draggable
                onDragStart={() => setDragMsg(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  moveMessage(dragMsg, i)
                  setDragMsg(null)
                }}
                className="flex gap-2 rounded-md border border-border p-2"
              >
                <GripVertical className="cursor-grab h-6 w-6 shrink-0 text-muted-foreground" />
                <select
                  className="h-9 rounded-md border border-border bg-background px-1 text-sm"
                  value={msg.role}
                  onChange={(e) =>
                    setGuided((g) => {
                      const next = [...g.messages]
                      next[i] = { ...next[i], role: e.target.value }
                      return { ...g, messages: next }
                    })
                  }
                >
                  <option value="user">user</option>
                  <option value="assistant">assistant</option>
                </select>
                <Textarea
                  value={msg.content}
                  onChange={(e) =>
                    setGuided((g) => {
                      const next = [...g.messages]
                      next[i] = { ...next[i], content: e.target.value }
                      return { ...g, messages: next }
                    })
                  }
                  className="min-h-[80px] flex-1"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    setGuided((g) => ({ ...g, messages: g.messages.filter((_, j) => j !== i) }))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground mt-1">
              Drag to reorder. Seeds the model&apos;s context with example conversations.
            </p>
          </Section>

          <Section title="8. License (LICENSE)" defaultOpen={false}>
            <Textarea
              value={guided.license}
              onChange={(e) => setGuided((g) => ({ ...g, license: e.target.value }))}
              className="min-h-[100px]"
            />
          </Section>

          <Section title="9. Requires (REQUIRES)">
            <Input
              value={guided.requires}
              onChange={(e) => setGuided((g) => ({ ...g, requires: e.target.value }))}
              placeholder="0.6.0"
              className="font-mono-ui"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Minimum Ollama version required for this model.
            </p>
          </Section>
        </TabsContent>

        <TabsContent value="raw">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRawText(formatModelfileText(rawText))}
            >
              Format
            </Button>
          </div>
          <div className="mt-3 flex gap-0 overflow-hidden rounded-md border border-border bg-background">
            <div className="font-mono-ui select-none border-r border-border bg-card py-2 pr-2 pl-2 text-right text-xs leading-6 text-muted-foreground">
              {rawLines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <Textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              onBlur={() => setRawErrors(validateRawModelfile(rawText))}
              spellCheck={false}
              className="min-h-[480px] flex-1 resize-y rounded-none border-0 font-mono-ui text-sm leading-6 focus-visible:ring-0"
            />
          </div>
          <div className="mt-2 rounded-md border border-border/80 bg-card/50 p-2 text-xs font-mono-ui leading-6">
            <div className="text-muted-foreground mb-2 text-[11px] uppercase tracking-wide">Preview highlight</div>
            {rawLines.slice(0, 12).map((line, idx) => (
              <div key={idx} className="whitespace-pre-wrap break-all">
                {highlightModelfileLine(line).map((chunk, j) => (
                  <span
                    key={j}
                    className={
                      chunk.kind === 'comment'
                        ? 'text-muted-foreground'
                        : chunk.kind === 'keyword'
                          ? 'text-primary font-semibold'
                          : 'text-foreground'
                    }
                  >
                    {chunk.text}
                  </span>
                ))}
              </div>
            ))}
            {rawLines.length > 12 && (
              <p className="text-muted-foreground mt-1">… {rawLines.length - 12} more lines</p>
            )}
          </div>
          {rawErrors.length > 0 && (
            <ul className="mt-2 text-xs text-destructive">
              {rawErrors.map((e) => (
                <li key={e.line}>
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Preview Modelfile</DialogTitle>
            <DialogDescription>Final text sent to Ollama create</DialogDescription>
          </DialogHeader>
          <Textarea readOnly className="min-h-[320px] font-mono-ui text-xs" value={finalizeModelfile()} />
          <Button type="button" variant="outline" size="sm" onClick={copyPreview}>
            <Copy className="h-4 w-4" />
            Copy
          </Button>
        </DialogContent>
      </Dialog>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
            Preview Modelfile
          </Button>
          <div className="flex flex-1 flex-col gap-2 sm:max-w-lg sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            <Input
              placeholder="New model name"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              className="font-mono-ui sm:max-w-[220px]"
            />
            {!isCreate && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => runSshApply(false)}
                disabled={creating || !modelName.trim()}
              >
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                Apply to Ollama
              </Button>
            )}
            {isCreate && (
              <Button type="button" onClick={runCreate} disabled={creating || !modelName.trim()}>
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Model
              </Button>
            )}
          </div>
        </div>
        {createStatus && (
          <p className="mx-auto mt-2 max-w-3xl truncate text-center text-xs text-muted-foreground">
            {createStatus}
          </p>
        )}
      </div>

      <ApplyTerminalPanel
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        lines={terminalLines}
        running={terminalRunning}
        result={terminalResult === 'success' ? 'success' : terminalResult === 'failed' ? 'failed' : null}
      />
    </div>
  )
}
