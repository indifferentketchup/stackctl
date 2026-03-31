import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { GitBranch, Plus, Pencil, Play, Trash2, Download } from 'lucide-react'
import { deleteFlow, listFlows, exportFlowN8n } from '@/api/flows.js'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Badge } from '@/components/ui/badge.jsx'

export function FlowsPage() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['flows'],
    queryFn: () => listFlows().then((r) => r.flows || []),
  })

  const onDelete = async (id) => {
    if (!confirm('Delete this flow?')) return
    await deleteFlow(id)
    qc.invalidateQueries({ queryKey: ['flows'] })
  }

  const onN8n = async (id, name) => {
    try {
      const wf = await exportFlowN8n(id)
      const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${String(name).replace(/[^a-z0-9-_]/gi, '_')}-flow-n8n.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      alert(e.message)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitBranch className="h-7 w-7" />
            Flows{' '}
            <Badge variant="outline" className="text-[10px] font-normal">
              beta
            </Badge>
          </h1>
          <p className="text-sm text-muted-foreground">Visual pipelines — sequential run with SSH nodes on sam-desktop.</p>
        </div>
        <Button asChild>
          <Link to="/flows/new">
            <Plus className="h-4 w-4" />
            New flow
          </Link>
        </Button>
      </header>

      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {(q.data || []).map((f) => (
          <Card key={f.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base truncate">{f.name}</CardTitle>
              {f.description && <p className="text-xs text-muted-foreground line-clamp-2">{f.description}</p>}
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 text-xs items-center">
              <span className="text-muted-foreground">{f.node_count ?? f.definition?.nodes?.length ?? 0} nodes</span>
              <div className="ml-auto flex flex-wrap gap-1">
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/flows/${f.id}`}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/flows/${f.id}`}>
                    <Play className="h-3.5 w-3.5" />
                    Run
                  </Link>
                </Button>
                <Button size="sm" variant="outline" onClick={() => onN8n(f.id, f.name)}>
                  <Download className="h-3.5 w-3.5" />
                  n8n
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onDelete(f.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {q.data?.length === 0 && !q.isLoading && (
        <p className="text-sm text-muted-foreground">No flows yet. Create a pipeline from input → LLM / tools → output.</p>
      )}
    </div>
  )
}
