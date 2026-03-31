import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
} from 'reactflow'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { createFlow, getFlow, updateFlow, runFlowSse } from '@/api/flows.js'
import { fetchSshStatus } from '@/api/models.js'
import { listAgents } from '@/api/agents.js'
import { SshStatusIndicator } from '@/components/SshStatusIndicator.jsx'
import { ApplyTerminalPanel } from '@/components/ApplyTerminalPanel.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'
import { cn } from '@/lib/utils.js'

import 'reactflow/dist/style.css'

let _nid = 0
function nid() {
  _nid += 1
  return `n_${Date.now()}_${_nid}`
}

const PALETTE = [
  { kind: 'input', icon: 'In', label: 'Input' },
  { kind: 'llm', icon: 'LLM', label: 'LLM' },
  { kind: 'agent', icon: 'Ag', label: 'Agent' },
  { kind: 'tool', icon: 'Tl', label: 'Tool' },
  { kind: 'transform', icon: 'Tr', label: 'Transform' },
  { kind: 'condition', icon: 'If', label: 'Condition' },
  { kind: 'http', icon: 'HTTP', label: 'HTTP' },
  { kind: 'ssh_command', icon: 'SSH', label: 'SSH cmd', ssh: true },
  { kind: 'ollama_create', icon: 'Oc', label: 'Ollama create', ssh: true },
  { kind: 'output', icon: 'Out', label: 'Output' },
]

const DEFAULTS = {
  input: { label: 'Input', text: '' },
  llm: {
    label: 'LLM',
    model: 'llama3.2',
    system_prompt: 'You are a helpful assistant.',
    temperature: 0.6,
    top_k: 20,
    top_p: 0.95,
    num_ctx: 8192,
  },
  agent: { label: 'Agent', agent_id: '' },
  tool: { label: 'Tool', tool_id: 'web_search', tool_config: {}, tool_params: {} },
  transform: { label: 'Transform', template: '{{input}}' },
  condition: { label: 'Condition', condition_type: 'contains', condition_value: '' },
  http: { label: 'HTTP', method: 'GET', url: '', body_template: '', allowed_domains: [] },
  ssh_command: { label: 'SSH', command: '', allowed_command_prefixes: ['Get-'] },
  ollama_create: { label: 'Create', model_name: '', modelfile_content: 'FROM .\n' },
  output: { label: 'Output' },
}

function nodeStyle(data, selected) {
  const k = data?.kind
  const ssh = k === 'ssh_command' || k === 'ollama_create'
  return {
    border: selected ? '2px solid var(--primary, #60a5fa)' : `1px solid ${ssh ? '#f59e0b' : '#444'}`,
    borderRadius: 8,
    padding: '8px 12px',
    background: ssh ? 'rgba(120, 53, 15, 0.5)' : 'rgba(30,30,30,0.95)',
    minWidth: 120,
    fontSize: 12,
  }
}

export function FlowEditorPage() {
  const { id: routeId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const isNew = !routeId || routeId === 'new'

  const [flowName, setFlowName] = useState('Untitled flow')
  const [flowDesc, setFlowDesc] = useState('')
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const onConnect = useCallback((p) => setEdges((eds) => addEdge(p, eds)), [setEdges])

  const [selectedId, setSelectedId] = useState(null)
  const [dataJson, setDataJson] = useState('{}')
  const [saving, setSaving] = useState(false)

  const [runInput, setRunInput] = useState('Hello')
  const [termOpen, setTermOpen] = useState(false)
  const [termLines, setTermLines] = useState([])
  const [termRun, setTermRun] = useState(false)
  const [termRes, setTermRes] = useState(null)

  const qFlow = useQuery({
    queryKey: ['flow', routeId],
    queryFn: () => getFlow(routeId),
    enabled: !isNew && !!routeId,
  })

  const qAgents = useQuery({ queryKey: ['agents'], queryFn: () => listAgents().then((r) => r.agents || []) })
  const qSsh = useQuery({
    queryKey: ['ssh-status'],
    queryFn: fetchSshStatus,
    refetchInterval: 30_000,
    retry: false,
  })

  const hasSshNodes = useMemo(
    () => nodes.some((n) => n.data?.kind === 'ssh_command' || n.data?.kind === 'ollama_create'),
    [nodes]
  )

  useEffect(() => {
    if (!qFlow.data) return
    setFlowName(qFlow.data.name || '')
    setFlowDesc(qFlow.data.description || '')
    const def = qFlow.data.definition || { nodes: [], edges: [] }
    const n = (def.nodes || []).map((raw) => ({
      id: raw.id,
      type: raw.type || 'default',
      position: raw.position || { x: 0, y: 0 },
      data: raw.data || { kind: 'transform', label: 'Node' },
      style: nodeStyle(raw.data, false),
    }))
    const e = (def.edges || []).map((raw) => ({
      id: raw.id || `e_${raw.source}_${raw.target}`,
      source: raw.source,
      target: raw.target,
      sourceHandle: raw.sourceHandle,
      animated: true,
    }))
    setNodes(n)
    setEdges(e)
  }, [qFlow.data, setNodes, setEdges])

  const selected = nodes.find((n) => n.id === selectedId)
  useEffect(() => {
    if (selected) setDataJson(JSON.stringify(selected.data, null, 2))
  }, [selectedId, selected?.data])

  const addNode = (kind, ssh) => {
    const d = { kind, ...(DEFAULTS[kind] || { label: kind }) }
    const y = 80 + nodes.length * 36
    setNodes((nds) => [
      ...nds,
      {
        id: nid(),
        position: { x: 40 + (nds.length % 4) * 180, y },
        data: d,
        style: nodeStyle(d, false),
      },
    ])
  }

  const applyDataJson = () => {
    if (!selectedId) return
    try {
      const parsed = JSON.parse(dataJson)
      if (!parsed.kind && selected) parsed.kind = selected.data.kind
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedId ? { ...n, data: parsed, style: nodeStyle(parsed, true) } : n
        )
      )
    } catch {
      alert('Invalid JSON')
    }
  }

  const toDefinition = () => ({
    nodes: nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: n.data,
      type: n.type || 'default',
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
    })),
  })

  const onSave = async () => {
    setSaving(true)
    try {
      const def = toDefinition()
      if (isNew) {
        const f = await createFlow({ name: flowName.trim() || 'Flow', description: flowDesc, definition: def })
        qc.invalidateQueries({ queryKey: ['flows'] })
        navigate(`/flows/${f.id}`, { replace: true })
      } else {
        await updateFlow(routeId, { name: flowName, description: flowDesc, definition: def })
        qc.invalidateQueries({ queryKey: ['flow', routeId] })
        qc.invalidateQueries({ queryKey: ['flows'] })
      }
    } catch (e) {
      alert(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const onRun = async () => {
    if (isNew || !routeId) {
      alert('Save the flow first')
      return
    }
    if (hasSshNodes && qSsh.data?.connected === false) {
      alert('Flow uses SSH nodes but sam-desktop is unreachable.')
      return
    }
    setTermLines([])
    setTermRes(null)
    setTermOpen(true)
    setTermRun(true)
    let sawDone = false
    let sawErr = false
    try {
      await runFlowSse(
        routeId,
        runInput,
        (ev) => {
          if (ev.type === 'node_start') {
            setTermLines((l) => [...l, `▶ ${ev.node_label || ev.node_type} (${ev.node_id})`])
          }
          if (ev.type === 'node_output') {
            setTermLines((l) => [...l, `   out: ${String(ev.output).slice(0, 500)}`])
          }
          if (ev.type === 'node_error') {
            setTermLines((l) => [...l, `   ERR: ${ev.error}`])
          }
          if (ev.type === 'done') {
            sawDone = true
            setTermLines((l) => [...l, `Done — output: ${String(ev.output).slice(0, 800)}`])
          }
          if (ev.type === 'error') {
            sawErr = true
            setTermLines((l) => [...l, ev.message || 'error'])
          }
        },
        undefined
      )
      setTermRes(sawErr ? 'failed' : sawDone ? 'success' : 'failed')
    } catch (e) {
      setTermLines((l) => [...l, e.message || 'run failed'])
      setTermRes('failed')
    } finally {
      setTermRun(false)
    }
  }

  if (!isNew && qFlow.isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-4rem)] min-h-[480px]">
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/flows">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <Input
          className="max-w-xs font-semibold"
          value={flowName}
          onChange={(e) => setFlowName(e.target.value)}
          placeholder="Flow name"
        />
        <Input
          className="max-w-sm text-sm text-muted-foreground"
          value={flowDesc}
          onChange={(e) => setFlowDesc(e.target.value)}
          placeholder="Description"
        />
        <SshStatusIndicator />
        {hasSshNodes && qSsh.data?.connected === false && (
          <span className="text-xs text-amber-400">SSH nodes blocked — sam-desktop down</span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
          <Button size="sm" variant="secondary" onClick={onRun} disabled={isNew}>
            Run
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 gap-2">
        <aside className="w-44 shrink-0 flex flex-col gap-1 overflow-y-auto border border-border rounded-md p-2 bg-card/30">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase">Add node</div>
          {PALETTE.map((p) => (
            <button
              key={p.kind}
              type="button"
              onClick={() => addNode(p.kind, p.ssh)}
              className={cn(
                'text-left text-xs rounded px-2 py-1.5 border border-border hover:bg-accent/30',
                p.ssh && 'bg-amber-950/40 border-amber-700/50'
              )}
            >
              <span className="font-mono opacity-60 mr-1">{p.icon}</span>
              {p.label}
              {p.ssh && <span className="ml-1 text-[9px] text-amber-400">SSH</span>}
            </button>
          ))}
        </aside>

        <div className="flex-1 min-w-0 min-h-[320px] border border-border rounded-md overflow-hidden bg-[#0c0c0c]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <MiniMap zoomable pannable />
          </ReactFlow>
        </div>

        <aside className="w-64 shrink-0 flex flex-col gap-2 border border-border rounded-md p-3 bg-card/30 overflow-y-auto">
          <div className="text-xs font-semibold">Node data (JSON)</div>
          {selectedId ? (
            <>
              <Textarea
                className="min-h-[200px] font-mono text-[11px]"
                value={dataJson}
                onChange={(e) => setDataJson(e.target.value)}
              />
              <Button size="sm" type="button" onClick={applyDataJson}>
                Apply
              </Button>
              {selected?.data?.kind === 'agent' && (
                <div>
                  <Label className="text-xs">Agent</Label>
                  <select
                    className="mt-1 w-full h-9 rounded border border-border bg-background text-xs px-2"
                    value={selected.data.agent_id || ''}
                    onChange={(e) => {
                      const v = e.target.value
                      setNodes((nds) =>
                        nds.map((n) =>
                          n.id === selectedId
                            ? { ...n, data: { ...n.data, agent_id: v }, style: nodeStyle({ ...n.data, agent_id: v }, true) }
                            : n
                        )
                      )
                      setDataJson((dj) => {
                        try {
                          const o = JSON.parse(dj)
                          o.agent_id = v
                          return JSON.stringify(o, null, 2)
                        } catch {
                          return dj
                        }
                      })
                    }}
                  >
                    <option value="">Select…</option>
                    {(qAgents.data || []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Select a node to edit its data.</p>
          )}
          <div className="pt-4 border-t border-border space-y-2">
            <Label className="text-xs">Run input</Label>
            <Textarea className="min-h-[72px] text-xs" value={runInput} onChange={(e) => setRunInput(e.target.value)} />
          </div>
        </aside>
      </div>

      <ApplyTerminalPanel
        open={termOpen}
        onClose={() => {
          setTermOpen(false)
          setTermLines([])
          setTermRes(null)
        }}
        lines={termLines}
        running={termRun}
        result={termRes}
      />
    </div>
  )
}
