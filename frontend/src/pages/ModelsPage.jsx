import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ArrowDownAZ,
  CalendarClock,
  ChevronDown,
  Copy,
  HardDrive,
  Info,
  Pencil,
  Trash2,
  Download,
  Layers,
  Loader2,
  Plus,
} from 'lucide-react'
import {
  copyModel,
  deleteModel,
  getVersion,
  pullModelStream,
  showModel,
  unloadAll,
} from '@/api/ollama.js'
import { consumeModelsSsePost } from '@/api/models.js'
import { ApplyTerminalPanel } from '@/components/ApplyTerminalPanel.jsx'
import { SshStatusIndicator } from '@/components/SshStatusIndicator.jsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.jsx'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card } from '@/components/ui/card.jsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { Progress } from '@/components/ui/progress.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'
import { cn } from '@/lib/utils.js'

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

function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso)
  }
}

const IM_END = '</think>'

const TEMPLATE_STOPS = {
  chatml: ['<|im_start|>', IM_END, '<|endoftext|>'],
  llama3: ['<|eot_id|>', '', ''],
  mistral: ['[INST]', '[/INST]'],
}

function suggestModelNameFromHfRef(raw) {
  let s = (raw || '').trim()
  if (!s) return ''
  s = s.replace(/^hf\.co\//i, '')
  s = s.replace(/[/:]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  return s.slice(0, 128) || 'model'
}

export function ModelsPage() {
  const qc = useQueryClient()
  const [sort, setSort] = useState('name')
  const [pullOpen, setPullOpen] = useState(false)
  const [pullName, setPullName] = useState('')
  const [hfMode, setHfMode] = useState(false)
  const [pullStatus, setPullStatus] = useState('')
  const [pullPct, setPullPct] = useState(0)
  const [pulling, setPulling] = useState(false)
  const [pullCtrl, setPullCtrl] = useState(null)

  const [hfOpen, setHfOpen] = useState(false)
  const [hfRef, setHfRef] = useState('')
  const [hfName, setHfName] = useState('')
  const [hfNameTouched, setHfNameTouched] = useState(false)
  const [hfTemplate, setHfTemplate] = useState('chatml')
  const [hfParamsOpen, setHfParamsOpen] = useState(false)
  const [hfTemperature, setHfTemperature] = useState(0.6)
  const [hfTopP, setHfTopP] = useState(0.95)
  const [hfTopK, setHfTopK] = useState(20)
  const [hfRepeatPen, setHfRepeatPen] = useState(1.0)
  const [hfNumCtx, setHfNumCtx] = useState(8192)
  const [hfStopsText, setHfStopsText] = useState(() => TEMPLATE_STOPS.chatml.join('\n'))

  const [termOpen, setTermOpen] = useState(false)
  const [termLines, setTermLines] = useState([])
  const [termRunning, setTermRunning] = useState(false)
  const [termResult, setTermResult] = useState(null)

  const [infoOpen, setInfoOpen] = useState(false)
  const [infoName, setInfoName] = useState('')
  const [infoData, setInfoData] = useState(null)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState('')

  const [copyRow, setCopyRow] = useState(null)
  const [copyDest, setCopyDest] = useState('')

  const [unloadConfirm, setUnloadConfirm] = useState(false)

  const { data: tags, isLoading } = useQuery({
    queryKey: ['ollama-models'],
    queryFn: async () => {
      const r = await fetch('/api/ollama/models')
      if (!r.ok) throw new Error(await r.text())
      return r.json()
    },
  })

  const { data: version } = useQuery({
    queryKey: ['ollama-version'],
    queryFn: getVersion,
    retry: false,
  })

  const models = useMemo(() => {
    const list = tags?.models
    if (!Array.isArray(list)) return []
    const mapped = list.map((m) => {
      const d = m.details || {}
      return {
        name: m.name || m.model || '',
        size: m.size,
        paramSize: d.parameter_size || d.parent_model || '—',
        quant: d.quantization_level || '—',
        modified: m.modified_at,
        raw: m,
      }
    })
    const sorted = [...mapped].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'size') return (b.size || 0) - (a.size || 0)
      if (sort === 'modified') {
        const da = new Date(a.modified || 0).getTime()
        const db = new Date(b.modified || 0).getTime()
        return db - da
      }
      return 0
    })
    return sorted
  }, [tags, sort])

  const openInfo = async (name) => {
    setInfoName(name)
    setInfoOpen(true)
    setInfoData(null)
    try {
      const d = await showModel(name)
      setInfoData(d)
    } catch (e) {
      setInfoData({ error: e.message })
    }
  }

  const delMut = useMutation({
    mutationFn: (n) => deleteModel(n),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ollama-models'] }),
  })

  const unloadMut = useMutation({
    mutationFn: unloadAll,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ollama-running'] }),
  })

  const copyMut = useMutation({
    mutationFn: ({ source, destination }) => copyModel(source, destination),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ollama-models'] })
      setCopyRow(null)
      setCopyDest('')
    },
  })

  const effectivePullName = hfMode && pullName && !pullName.startsWith('hf.co/')
    ? `hf.co/${pullName.replace(/^\/*/, '')}`
    : pullName

  const noTagWarning =
    effectivePullName.trim().length > 0 && !effectivePullName.includes(':')

  const startPull = async () => {
    const m = effectivePullName.trim()
    if (!m || pulling) return
    const ac = new AbortController()
    setPullCtrl(ac)
    setPulling(true)
    setPullStatus('Starting…')
    setPullPct(0)
    try {
      await pullModelStream(
        m,
        (ev) => {
          if (ev.error) {
            setPullStatus(ev.error)
            return
          }
          const st = ev.status || ''
          setPullStatus(st)
          const c = ev.completed
          const t = ev.total
          if (typeof c === 'number' && typeof t === 'number' && t > 0) {
            setPullPct(Math.min(100, Math.round((100 * c) / t)))
          }
        },
        ac.signal
      )
      setPullStatus('Done')
      setPullPct(100)
      qc.invalidateQueries({ queryKey: ['ollama-models'] })
    } catch (e) {
      if (e.name !== 'AbortError') setPullStatus(e.message || 'Pull failed')
    } finally {
      setPulling(false)
      setPullCtrl(null)
    }
  }

  const cancelPull = () => {
    pullCtrl?.abort()
  }

  const effectiveHfRef = (() => {
    const r = hfRef.trim()
    if (!r) return ''
    return r.toLowerCase().startsWith('hf.co/') ? r : `hf.co/${r.replace(/^\/*/, '')}`
  })()

  const startPullAndCreate = async () => {
    const ref = effectiveHfRef
    const n = hfName.trim()
    if (!ref || !n) return
    setTermLines([])
    setTermResult(null)
    setTermOpen(true)
    setTermRunning(true)
    let sawDone = false
    let sawErr = false
    const stops = hfStopsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      await consumeModelsSsePost(
        '/api/models/pull-and-create',
        {
          hf_ref: ref,
          name: n,
          template: hfTemplate,
          parameters: {
            temperature: hfTemperature,
            top_p: hfTopP,
            top_k: hfTopK,
            repeat_penalty: hfRepeatPen,
            num_ctx: hfNumCtx,
            stop: stops,
          },
        },
        (ev) => {
          if (ev.type === 'log' && ev.line != null) {
            setTermLines((prev) => [...prev, String(ev.line)])
          }
          if (ev.type === 'error') {
            sawErr = true
            setTermLines((prev) => [...prev, ev.message || 'Error'])
            setTermResult('failed')
          }
          if (ev.type === 'done' && ev.success) {
            sawDone = true
            setTermResult('success')
            qc.invalidateQueries({ queryKey: ['ollama-models'] })
          }
        },
        undefined,
      )
      if (!sawDone && !sawErr) {
        setTermLines((prev) => [...prev, 'Stream ended without completion'])
        setTermResult('failed')
      }
    } catch (e) {
      setTermLines((prev) => [...prev, e.message || 'Failed'])
      setTermResult('failed')
    } finally {
      setTermRunning(false)
      setHfOpen(false)
    }
  }

  return (
    <div className="mx-auto max-w-[1200px] space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Local Models</h1>
          <p className="text-sm text-muted-foreground">
            Pull, inspect, and manage models on your Ollama host.
          </p>
          <SshStatusIndicator className="mt-3" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {version?.running && (
            <Badge variant="secondary">Ollama {version.running}</Badge>
          )}
          {version?.update_available && (
            <a
              href="https://github.com/ollama/ollama/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              <Badge variant="amber">Update available{version.latest ? ` → ${version.latest}` : ''}</Badge>
            </a>
          )}
          <Button variant="outline" size="sm" onClick={() => setUnloadConfirm(true)}>
            Unload all
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPullOpen(true)}>
            <Download className="h-4 w-4" />
            Pull model
          </Button>
          <Button variant="outline" size="sm" onClick={() => setHfOpen(true)}>
            <Download className="h-4 w-4" />
            Pull from HuggingFace
          </Button>
          <Button size="sm" asChild>
            <Link to="/models/create">
              <Plus className="h-4 w-4" />
              Create model
            </Link>
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        <span className="text-xs text-muted-foreground self-center mr-2">Sort:</span>
        <Button
          variant={sort === 'name' ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setSort('name')}
        >
          <ArrowDownAZ className="h-4 w-4" />
          Name
        </Button>
        <Button
          variant={sort === 'size' ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setSort('size')}
        >
          <HardDrive className="h-4 w-4" />
          Size
        </Button>
        <Button
          variant={sort === 'modified' ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setSort('modified')}
        >
          <CalendarClock className="h-4 w-4" />
          Modified
        </Button>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-card/80 text-muted-foreground">
              <th className="p-3 font-semibold">Name</th>
              <th className="p-3 font-semibold">Size</th>
              <th className="p-3 font-semibold">Param size</th>
              <th className="p-3 font-semibold">Quantization</th>
              <th className="p-3 font-semibold">Modified</th>
              <th className="p-3 font-semibold w-[200px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  <Loader2 className="inline h-5 w-5 animate-spin" /> Loading…
                </td>
              </tr>
            )}
            {!isLoading && models.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  No models found. Pull or create one to get started.
                </td>
              </tr>
            )}
            {models.map((row) => (
              <tr key={row.name} className="border-b border-border/80 hover:bg-accent/10">
                <td className="p-3 font-mono-ui text-xs sm:text-sm break-all max-w-[200px]">
                  {row.name}
                </td>
                <td className="p-3 whitespace-nowrap">{formatBytes(row.size)}</td>
                <td className="p-3">{row.paramSize}</td>
                <td className="p-3">{row.quant}</td>
                <td className="p-3 whitespace-nowrap text-xs text-muted-foreground">
                  {formatDate(row.modified)}
                </td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" size="icon" title="Info" onClick={() => openInfo(row.name)}>
                      <Info className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Edit" asChild>
                      <Link to={`/models/${encodeURIComponent(row.name)}`}>
                        <Pencil className="h-4 w-4" />
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Copy"
                      onClick={() => {
                        setCopyRow(row.name)
                        setCopyDest(`${row.name}-copy`)
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setDeleteTarget(row.name)
                        setDeleteOpen(true)
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Pull drawer panel */}
      <div
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 max-h-[85vh] overflow-y-auto border-t border-border bg-card shadow-2xl transition-transform duration-200 md:left-auto md:right-4 md:top-16 md:max-h-[calc(100vh-5rem)] md:w-[420px] md:rounded-lg md:border',
          pullOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none md:translate-y-0 md:opacity-0 md:pointer-events-none'
        )}
      >
        <div className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Layers className="h-5 w-5" />
              Pull model
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setPullOpen(false)}>
              Close
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={!hfMode ? 'secondary' : 'outline'}
              onClick={() => setHfMode(false)}
            >
              Ollama registry
            </Button>
            <Button
              type="button"
              size="sm"
              variant={hfMode ? 'secondary' : 'outline'}
              onClick={() => setHfMode(true)}
            >
              HuggingFace (hf.co)
            </Button>
          </div>
          <div>
            <Label>Model{hfMode ? ' (prefix added)' : ''}</Label>
            <Input
              className="mt-1 font-mono-ui text-sm"
              placeholder={hfMode ? 'user/repo:Q4_K_M' : 'llama3.2:latest'}
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {hfMode
                ? 'We prefix hf.co/ automatically.'
                : 'Use name:tag from the Ollama library.'}
            </p>
          </div>
          {noTagWarning && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              Tip: specify a quant tag e.g. <code className="font-mono-ui">:Q4_K_M</code>
            </div>
          )}
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button onClick={startPull} disabled={pulling || !effectivePullName.trim()}>
                {pulling && <Loader2 className="h-4 w-4 animate-spin" />}
                Pull
              </Button>
              <Button variant="outline" onClick={cancelPull} disabled={!pulling}>
                Cancel
              </Button>
            </div>
            {pullStatus && <p className="text-xs text-muted-foreground break-words">{pullStatus}</p>}
            <Progress value={pullPct} />
          </div>
        </div>
      </div>
      {pullOpen && (
        <button
          type="button"
          aria-label="Close overlay"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setPullOpen(false)}
        />
      )}

      <div
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 max-h-[90vh] overflow-y-auto border-t border-border bg-card shadow-2xl transition-transform duration-200 md:left-auto md:right-4 md:top-16 md:max-h-[calc(100vh-5rem)] md:w-[480px] md:rounded-lg md:border',
          hfOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none md:translate-y-0 md:opacity-0 md:pointer-events-none',
        )}
      >
        <div className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Pull from HuggingFace</h2>
            <Button variant="ghost" size="sm" onClick={() => setHfOpen(false)}>
              Close
            </Button>
          </div>
          <div>
            <Label>HF reference</Label>
            <Input
              className="mt-1 font-mono-ui text-sm"
              placeholder="hf.co/user/repo:Q4_K_M"
              value={hfRef}
              onChange={(e) => {
                const v = e.target.value
                setHfRef(v)
                if (!hfNameTouched) setHfName(suggestModelNameFromHfRef(v))
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Include the quant tag e.g. :Q4_K_M — omitting it pulls the default which may include a vision
              projector.
            </p>
          </div>
          <div>
            <Label>Model name</Label>
            <Input
              className="mt-1 font-mono-ui text-sm"
              placeholder="my-model-name"
              value={hfName}
              onChange={(e) => {
                setHfNameTouched(true)
                setHfName(e.target.value)
              }}
            />
          </div>
          <div>
            <Label>Template</Label>
            <select
              className="mt-1 flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none ring-ring focus-visible:ring-2"
              value={hfTemplate}
              onChange={(e) => {
                const t = e.target.value
                setHfTemplate(t)
                setHfStopsText((TEMPLATE_STOPS[t] || TEMPLATE_STOPS.chatml).join('\n'))
              }}
            >
              <option value="chatml">ChatML</option>
              <option value="llama3">Llama3</option>
              <option value="mistral">Mistral</option>
            </select>
          </div>

          <Collapsible open={hfParamsOpen} onOpenChange={setHfParamsOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-semibold hover:bg-accent/10">
              Parameters
              <ChevronDown className={cn('h-4 w-4 transition-transform', hfParamsOpen && 'rotate-180')} />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-3 px-1">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs">temperature</Label>
                  <Input
                    type="number"
                    step="0.05"
                    className="mt-1"
                    value={hfTemperature}
                    onChange={(e) => setHfTemperature(parseFloat(e.target.value) || 0)}
                  />
                </div>
                <div>
                  <Label className="text-xs">top_p</Label>
                  <Input
                    type="number"
                    step="0.05"
                    className="mt-1"
                    value={hfTopP}
                    onChange={(e) => setHfTopP(parseFloat(e.target.value) || 0)}
                  />
                </div>
                <div>
                  <Label className="text-xs">top_k</Label>
                  <Input
                    type="number"
                    className="mt-1"
                    value={hfTopK}
                    onChange={(e) => setHfTopK(parseInt(e.target.value, 10) || 0)}
                  />
                </div>
                <div>
                  <Label className="text-xs">repeat_penalty</Label>
                  <Input
                    type="number"
                    step="0.05"
                    className="mt-1"
                    value={hfRepeatPen}
                    onChange={(e) => setHfRepeatPen(parseFloat(e.target.value) || 0)}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs">num_ctx</Label>
                  <Input
                    type="number"
                    className="mt-1"
                    value={hfNumCtx}
                    onChange={(e) => setHfNumCtx(parseInt(e.target.value, 10) || 8192)}
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">Stop tokens (one per line)</Label>
                <Textarea
                  className="mt-1 min-h-[100px] font-mono-ui text-xs"
                  value={hfStopsText}
                  onChange={(e) => setHfStopsText(e.target.value)}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Button
            onClick={startPullAndCreate}
            disabled={termRunning || !effectiveHfRef || !hfName.trim()}
          >
            {termRunning && <Loader2 className="h-4 w-4 animate-spin" />}
            Pull &amp; Create
          </Button>
        </div>
      </div>
      {hfOpen && (
        <button
          type="button"
          aria-label="Close HF overlay"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setHfOpen(false)}
        />
      )}

      <ApplyTerminalPanel
        open={termOpen}
        onClose={() => setTermOpen(false)}
        lines={termLines}
        running={termRunning}
        result={termResult === 'success' ? 'success' : termResult === 'failed' ? 'failed' : null}
      />

      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Model: {infoName}</DialogTitle>
            <DialogDescription>Output from Ollama show</DialogDescription>
          </DialogHeader>
          {!infoData && <Loader2 className="h-6 w-6 animate-spin" />}
          {infoData?.error && (
            <p className="text-sm text-destructive">{infoData.error}</p>
          )}
          {infoData && !infoData.error && (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto text-sm">
              <div>
                <div className="text-xs font-semibold text-muted-foreground">Modelfile</div>
                <Textarea readOnly className="mt-1 min-h-[120px] font-mono-ui text-xs" value={infoData.modelfile || ''} />
              </div>
              <div>
                <div className="text-xs font-semibold text-muted-foreground">Template</div>
                <Textarea readOnly className="mt-1 min-h-[80px] font-mono-ui text-xs" value={infoData.template || ''} />
              </div>
              <div>
                <div className="text-xs font-semibold text-muted-foreground">Parameters</div>
                <pre className="mt-1 overflow-x-auto rounded border border-border bg-background p-2 font-mono-ui text-xs">
                  {typeof infoData.parameters === 'string'
                    ? infoData.parameters
                    : JSON.stringify(infoData.parameters || {}, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete model?</DialogTitle>
            <DialogDescription>
              This permanently removes <strong className="text-foreground">{deleteTarget}</strong> from disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                delMut.mutate(deleteTarget, {
                  onSuccess: () => setDeleteOpen(false),
                })
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!copyRow} onOpenChange={(o) => !o && setCopyRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy model</DialogTitle>
            <DialogDescription>New name (destination tag)</DialogDescription>
          </DialogHeader>
          <Input value={copyDest} onChange={(e) => setCopyDest(e.target.value)} className="font-mono-ui" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyRow(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                copyRow &&
                copyDest.trim() &&
                copyMut.mutate({ source: copyRow, destination: copyDest.trim() })
              }
              disabled={!copyDest.trim() || copyMut.isPending}
            >
              {copyMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={unloadConfirm} onOpenChange={setUnloadConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unload all models?</DialogTitle>
            <DialogDescription>
              Sends keep_alive 0 to every loaded model to free VRAM.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnloadConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                unloadMut.mutate(undefined, {
                  onSuccess: () => setUnloadConfirm(false),
                })
              }
            >
              Unload all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
