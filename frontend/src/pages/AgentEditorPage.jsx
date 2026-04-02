import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import {
  createAgent,
  getAgent,
  updateAgent,
  listAgentRuns,
  runAgentSse,
} from '@/api/agents.js'
import { listModels } from '@/api/ollama.js'
import { listPersonas } from '@/api/personas.js'
import { fetchSshStatus } from '@/api/models.js'
import { SshStatusIndicator } from '@/components/SshStatusIndicator.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'
import { cn } from '@/lib/utils.js'

const TOOL_HELP = `When tools are enabled, the model may call them. Example:
[{"tool":"web_search","config":{"searxng_url":"http://100.x.x.x:8080","max_results":5}}]

SSH tools (file_read, run_powershell) require sam-desktop SSH.`

const TOOL_INSTR = `\n\nWhen a tool is available, call it with the correct name and JSON arguments. Summarize tool output for the user.`

export function AgentEditorPage() {
  const { id: routeId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const isNew = !routeId || routeId === 'new'

  const [tab, setTab] = useState(() => searchParams.get('tab') || 'config')
  useEffect(() => {
    const t = searchParams.get('tab')
    if (t) setTab(t)
  }, [searchParams])

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [toolsJson, setToolsJson] = useState('[]')
  const [memoryEnabled, setMemoryEnabled] = useState(false)
  const [memoryWindow, setMemoryWindow] = useState(10)
  const [temperature, setTemperature] = useState(0.6)
  const [topK, setTopK] = useState(20)
  const [topP, setTopP] = useState(0.95)
  const [numCtx, setNumCtx] = useState(8192)

  const [saving, setSaving] = useState(false)
  const [runId, setRunId] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chatLog, setChatLog] = useState([])
  const [runBusy, setRunBusy] = useState(false)
  const [streamText, setStreamText] = useState('')

  const qAgent = useQuery({
    queryKey: ['agent', routeId],
    queryFn: () => getAgent(routeId),
    enabled: !isNew && !!routeId,
  })

  const qModels = useQuery({ queryKey: ['ollama', 'models'], queryFn: listModels })
  const qPersonas = useQuery({ queryKey: ['personas'], queryFn: listPersonas })
  const qRuns = useQuery({
    queryKey: ['agent-runs', routeId],
    queryFn: () => listAgentRuns(routeId).then((r) => r.runs || []),
    enabled: !isNew && !!routeId,
  })
  const qSsh = useQuery({
    queryKey: ['ssh-status'],
    queryFn: fetchSshStatus,
    refetchInterval: 30_000,
    retry: false,
  })

  const modelOptions = useMemo(() => {
    const m = qModels.data?.models
    if (!Array.isArray(m)) return []
    return m.map((x) => x.name || x.model).filter(Boolean)
  }, [qModels.data])

  useEffect(() => {
    if (!qAgent.data) return
    const a = qAgent.data
    setName(a.name || '')
    setDescription(a.description || '')
    setModel(a.model || '')
    setSystemPrompt(a.system_prompt || '')
    setToolsJson(JSON.stringify(a.tools || [], null, 2))
    setMemoryEnabled(!!a.memory_enabled)
    setMemoryWindow(a.memory_window ?? 10)
    setTemperature(a.temperature ?? 0.6)
    setTopK(a.top_k ?? 20)
    setTopP(a.top_p ?? 0.95)
    setNumCtx(a.num_ctx ?? 8192)
  }, [qAgent.data])

  const parsedTools = () => {
    try {
      const t = JSON.parse(toolsJson || '[]')
      return Array.isArray(t) ? t : []
    } catch {
      return null
    }
  }

  const buildPayload = () => {
    const tools = parsedTools()
    if (tools === null) throw new Error('Invalid tools JSON')
    return {
      name: name.trim(),
      description: description.trim(),
      model: model.trim(),
      system_prompt: systemPrompt,
      tools,
      memory_enabled: memoryEnabled,
      memory_window: Number(memoryWindow),
      temperature: Number(temperature),
      top_k: Number(topK),
      top_p: Number(topP),
      num_ctx: Number(numCtx),
    }
  }

  const onSave = async () => {
    setSaving(true)
    try {
      const payload = buildPayload()
      if (isNew) {
        const created = await createAgent(payload)
        qc.invalidateQueries({ queryKey: ['agents'] })
        navigate(`/agents/${created.id}`, { replace: true })
      } else {
        await updateAgent(routeId, payload)
        qc.invalidateQueries({ queryKey: ['agent', routeId] })
        qc.invalidateQueries({ queryKey: ['agents'] })
      }
    } catch (e) {
      alert(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const fillFromPersona = () => {
    const ps = qPersonas.data?.personas || qPersonas.data
    const list = Array.isArray(ps) ? ps : []
    if (!list.length) {
      alert('No personas loaded — check boolab token in Personas page.')
      return
    }
    const namePick = prompt(
      `Persona name or id?\n${list
        .slice(0, 12)
        .map((p) => p.name || p.id)
        .join(', ')}`
    )
    if (!namePick) return
    const p = list.find((x) => x.name === namePick || x.id === namePick)
    if (p?.system_prompt) setSystemPrompt(p.system_prompt)
    else if (p?.prompt) setSystemPrompt(p.prompt)
    else alert('Persona has no system_prompt field')
  }

  const insertToolInstr = () => setSystemPrompt((s) => (s || '') + TOOL_INSTR)

  const sendChat = async () => {
    if (isNew || !routeId || !chatInput.trim()) return
    const usesSshTools = parsedTools()?.some((t) =>
      ['file_read', 'run_powershell'].includes(t.tool)
    )
    if (usesSshTools && qSsh.data?.connected === false) {
      alert('SSH tools need sam-desktop — connect first.')
      return
    }
    setRunBusy(true)
    setStreamText('')
    const userLine = chatInput.trim()
    setChatInput('')
    setChatLog((l) => [...l, { role: 'user', text: userLine }])
    let acc = ''
    try {
      await runAgentSse(
        routeId,
        { message: userLine, run_id: runId || null },
        (ev) => {
          if (ev.type === 'token' && ev.content) {
            acc += ev.content
            setStreamText(acc)
          }
          if (ev.type === 'tool_call') {
            setChatLog((l) => [
              ...l,
              { role: 'tool_call', tool: ev.tool, args: ev.args },
            ])
          }
          if (ev.type === 'tool_result') {
            setChatLog((l) => [...l, { role: 'tool_result', tool: ev.tool, text: ev.result }])
          }
          if (ev.type === 'error') {
            setChatLog((l) => [...l, { role: 'error', text: ev.message }])
          }
        },
        undefined
      )
      if (acc) setChatLog((l) => [...l, { role: 'assistant', text: acc }])
      setStreamText('')
      qc.invalidateQueries({ queryKey: ['agent-runs', routeId] })
    } catch (e) {
      setChatLog((l) => [...l, { role: 'error', text: e.message }])
    } finally {
      setRunBusy(false)
    }
  }

  const newRun = () => {
    setRunId('')
    setChatLog([])
    setStreamText('')
  }

  if (!isNew && qAgent.isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-24">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/agents">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">{isNew ? 'New agent' : 'Edit agent'}</h1>
        <SshStatusIndicator className="ml-auto" />
      </div>

      <Tabs value={tab} onValueChange={(v) => { setTab(v); setSearchParams(v === 'config' ? {} : { tab: v }) }}>
        <TabsList className="w-full flex-wrap h-auto">
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="test" disabled={isNew}>
            Test
          </TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="space-y-4 mt-4">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Model</Label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Select…</option>
              {modelOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap gap-2">
              <Label className="w-full">System prompt</Label>
              <Button type="button" size="sm" variant="secondary" onClick={fillFromPersona}>
                From persona
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={insertToolInstr}>
                Insert tool instructions
              </Button>
            </div>
            <Textarea
              className="min-h-[160px] font-mono-ui text-sm"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{systemPrompt.length} chars</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Temperature</Label>
              <Input
                type="number"
                step="0.05"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
            <div>
              <Label>Top P</Label>
              <Input type="number" step="0.05" value={topP} onChange={(e) => setTopP(e.target.value)} />
            </div>
            <div>
              <Label>Top K</Label>
              <Input type="number" value={topK} onChange={(e) => setTopK(e.target.value)} />
            </div>
            <div>
              <Label>num_ctx</Label>
              <Input type="number" value={numCtx} onChange={(e) => setNumCtx(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(e) => setMemoryEnabled(e.target.checked)}
            />
            Session memory
          </label>
          {memoryEnabled && (
            <div>
              <Label>Memory window (messages)</Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={memoryWindow}
                onChange={(e) => setMemoryWindow(e.target.value)}
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="tools" className="space-y-3 mt-4">
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">{TOOL_HELP}</p>
          <p className="text-xs text-amber-200/90 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
            file_read / run_powershell execute on sam-desktop via SSH — not on homelab.
          </p>
          <Textarea
            className="min-h-[220px] font-mono-ui text-xs"
            value={toolsJson}
            onChange={(e) => setToolsJson(e.target.value)}
          />
        </TabsContent>

        <TabsContent value="test" className="space-y-4 mt-4">
          <div className="rounded-md border border-border p-3 text-xs space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              <span>
                Run ID: <code className="font-mono-ui">{runId || '(new)'}</code>
              </span>
              <Button type="button" size="sm" variant="outline" onClick={newRun}>
                New run
              </Button>
              {qRuns.data?.length > 0 && (
                <select
                  className="h-8 rounded border border-border bg-background px-2 text-xs"
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                >
                  <option value="">Latest (new)</option>
                  {(qRuns.data || []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id.slice(0, 8)}… {r.created_at || ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <p className="text-muted-foreground">Model: {model || '—'}</p>
          </div>
          <div className="message-content rounded-md border border-border bg-card/40 min-h-[200px] max-h-[360px] overflow-y-auto overflow-x-hidden p-3 text-sm space-y-2 w-full max-w-full">
            {chatLog.map((m, i) => (
              <div
                key={i}
                className={cn(
                  'chat-message',
                  m.role === 'user' && 'text-sky-300',
                  m.role === 'error' && 'text-red-400'
                )}
              >
                {m.role === 'tool_call' && (
                  <div className="rounded border border-border/60 p-2 text-xs min-w-0">
                    <div className="font-semibold">Tool: {m.tool}</div>
                    <pre className="mt-1 min-w-0 whitespace-pre-wrap opacity-90">{JSON.stringify(m.args, null, 2)}</pre>
                  </div>
                )}
                {m.role === 'tool_result' && (
                  <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs min-w-0">
                    <div className="font-semibold text-emerald-300">Result · {m.tool}</div>
                    <pre className="mt-1 min-w-0 whitespace-pre-wrap">{String(m.text).slice(0, 2000)}</pre>
                  </div>
                )}
                {(m.role === 'user' || m.role === 'assistant' || m.role === 'error') && (
                  <div className="min-w-0">
                    <span className="text-[10px] uppercase text-muted-foreground">{m.role}</span>
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  </div>
                )}
              </div>
            ))}
            {streamText && (
              <div className="chat-message min-w-0">
                <span className="text-[10px] uppercase text-muted-foreground">assistant</span>
                <p className="whitespace-pre-wrap break-words">{streamText}</p>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Message…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendChat())}
              disabled={runBusy}
            />
            <Button onClick={sendChat} disabled={runBusy || !chatInput.trim()}>
              {runBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              Send
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex gap-2">
        <Button onClick={onSave} disabled={saving || !name.trim() || !model || !systemPrompt.trim()}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  )
}
