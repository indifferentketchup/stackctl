import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Bot, Plus, Pencil, Play, Trash2, Download } from 'lucide-react'
import { deleteAgent, listAgents, exportAgentN8n, exportAgentDaw } from '@/api/agents.js'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Badge } from '@/components/ui/badge.jsx'

export function AgentsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['agents'], queryFn: () => listAgents().then((r) => r.agents || []) })

  const onDelete = async (id) => {
    if (!confirm('Delete this agent?')) return
    await deleteAgent(id)
    qc.invalidateQueries({ queryKey: ['agents'] })
  }

  const onExportN8n = async (id, name) => {
    try {
      const wf = await exportAgentN8n(id)
      const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${name.replace(/[^a-z0-9-_]/gi, '_')}-n8n.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      alert(e.message)
    }
  }

  const onExportDaw = async (id) => {
    if (!confirm('Create a DAW in boolab with this agent?')) return
    try {
      const r = await exportAgentDaw(id)
      alert(`Created: ${JSON.stringify(r).slice(0, 200)}`)
    } catch (e) {
      alert(e.message || 'Export failed — is BOOLAB_API_URL set?')
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="h-7 w-7" />
            Agents
          </h1>
          <p className="text-sm text-muted-foreground">Models, prompts, tools, and test chat (Ollama via Tailscale).</p>
        </div>
        <Button asChild>
          <Link to="/agents/new">
            <Plus className="h-4 w-4" />
            New agent
          </Link>
        </Button>
      </header>

      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {(q.data || []).map((a) => (
          <Card key={a.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-start justify-between gap-2">
                <span className="truncate">{a.name}</span>
                <Badge variant="secondary" className="shrink-0 font-mono-ui text-[10px]">
                  {a.model}
                </Badge>
              </CardTitle>
              {a.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{a.description}</p>
              )}
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 text-xs">
              <span className="text-muted-foreground">{(a.tools || []).length} tools</span>
              <div className="ml-auto flex flex-wrap gap-1">
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/agents/${a.id}`}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/agents/${a.id}?tab=test`}>
                    <Play className="h-3.5 w-3.5" />
                    Run
                  </Link>
                </Button>
                <Button size="sm" variant="outline" onClick={() => onExportDaw(a.id)}>
                  DAW
                </Button>
                <Button size="sm" variant="outline" onClick={() => onExportN8n(a.id, a.name)}>
                  <Download className="h-3.5 w-3.5" />
                  n8n
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onDelete(a.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {q.data?.length === 0 && !q.isLoading && (
        <p className="text-sm text-muted-foreground">No agents yet. Create one to combine a model with tools and memory.</p>
      )}
    </div>
  )
}
