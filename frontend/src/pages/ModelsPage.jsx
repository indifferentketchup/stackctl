import { useMemo, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Check, Layers, Loader2, Minus, RefreshCw } from 'lucide-react'
import { getModelCatalog } from '@/api/models.js'
import { getMachineHealth, getMachines, tabbyLoad, warmFramework } from '@/api/machines.js'
import { FrameworkBadge } from '@/components/machines/FrameworkBadge.jsx'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent } from '@/components/ui/card.jsx'
import { Input } from '@/components/ui/input.jsx'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.jsx'
import { cn } from '@/lib/utils.js'

function formatBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (v < 1024) return `${v} B`
  const kb = v / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
}

function formatCtx(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (v >= 1024) return `${Math.round(v / 1024)}k`
  return String(v)
}

function quantBadgeClass(quant) {
  const q = (quant || '').toUpperCase().replace(/-/g, '_')
  if (!q) return 'bg-muted text-muted-foreground'
  if (q.includes('Q8') || q === 'Q8_0') return 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
  if (q.includes('Q6') || q.includes('Q6K')) return 'bg-teal-600/15 text-teal-700 dark:text-teal-400'
  if (q.includes('Q4_K_M') || q.includes('Q4KM') || q.includes('Q4_K_XL') || q.includes('Q4KXL'))
    return 'bg-blue-600/15 text-blue-700 dark:text-blue-400'
  if (q.includes('Q4')) return 'bg-blue-600/15 text-blue-700 dark:text-blue-400'
  if (q.includes('Q3') || q.includes('Q2')) return 'bg-amber-600/15 text-amber-800 dark:text-amber-400'
  if (q.includes('EXL')) return 'bg-purple-600/15 text-purple-700 dark:text-purple-400'
  return 'bg-muted text-muted-foreground'
}

const SORTS = ['name', 'machine', 'status', 'bifrost', 'vram', 'context', 'quant']

function sortModels(rows, key, dir) {
  const mul = dir === 'asc' ? 1 : -1
  const v = (m) => {
    switch (key) {
      case 'name':
        return (m.name || '').toLowerCase()
      case 'machine':
        return (m.machine_name || '').toLowerCase()
      case 'status':
        return m.is_loaded ? 1 : 0
      case 'bifrost':
        return m.in_bifrost ? 1 : 0
      case 'vram':
        return m.vram_bytes ?? -1
      case 'context':
        return m.ctx_size ?? -1
      case 'quant':
        return (m.quant || '').toLowerCase()
      default:
        return 0
    }
  }
  return [...rows].sort((a, b) => {
    const va = v(a)
    const vb = v(b)
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul
    if (va < vb) return -1 * mul
    if (va > vb) return 1 * mul
    return 0
  })
}

function TableSkeleton({ rows = 8 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 w-full animate-pulse rounded bg-muted" />
      ))}
    </div>
  )
}

export function ModelsPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [fwFilter, setFwFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [machineFilter, setMachineFilter] = useState('all')
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [selected, setSelected] = useState(null)

  const qMachines = useQuery({
    queryKey: ['machines'],
    queryFn: getMachines,
  })

  const machines = qMachines.data?.machines ?? []

  const healthQueries = useQueries({
    queries: machines.map((m) => ({
      queryKey: ['machine-health', m.id],
      queryFn: () => getMachineHealth(m.id),
      refetchInterval: 60_000,
    })),
  })

  const qCatalog = useQuery({
    queryKey: ['model-catalog'],
    queryFn: getModelCatalog,
    refetchInterval: 30_000,
  })

  const models = qCatalog.data?.models ?? []

  const machinesOnline = useMemo(() => {
    let n = 0
    machines.forEach((m, i) => {
      const h = healthQueries[i]?.data
      if (h?.ok) n += 1
    })
    return n
  }, [machines, healthQueries])

  const filtered = useMemo(() => {
    let rows = models
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter((m) => (m.name || '').toLowerCase().includes(q))
    if (fwFilter !== 'all') rows = rows.filter((m) => (m.framework || '').toLowerCase() === fwFilter)
    if (statusFilter === 'loaded') rows = rows.filter((m) => m.is_loaded)
    if (statusFilter === 'bifrost') rows = rows.filter((m) => m.in_bifrost)
    if (machineFilter !== 'all') rows = rows.filter((m) => (m.machine_name || '') === machineFilter)
    return rows
  }, [models, search, fwFilter, statusFilter, machineFilter])

  const sorted = useMemo(() => sortModels(filtered, sortKey, sortDir), [filtered, sortKey, sortDir])

  const total = models.length
  const loadedCount = models.filter((m) => m.is_loaded).length
  const bifrostCount = models.filter((m) => m.in_bifrost).length

  const warmMut = useMutation({
    mutationFn: ({ id, name }) => warmFramework(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['model-catalog'] })
    },
  })

  const tabbyLoadMut = useMutation({
    mutationFn: ({ id, name }) => tabbyLoad(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['model-catalog'] })
    },
  })

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sortLabel = (key, label) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-medium hover:text-foreground"
      onClick={() => toggleSort(key)}
    >
      {label}
      {sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  )

  const lastUpdated =
    qCatalog.dataUpdatedAt && !Number.isNaN(qCatalog.dataUpdatedAt)
      ? new Date(qCatalog.dataUpdatedAt).toLocaleString()
      : '—'

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Models</h1>
            <p className="text-sm text-muted-foreground">Last updated: {lastUpdated}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={qCatalog.isFetching}
          onClick={() => qc.invalidateQueries({ queryKey: ['model-catalog'] })}
        >
          {qCatalog.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Total models</p>
            <p className="text-2xl font-semibold tabular-nums">{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Loaded now</p>
            <p className="text-2xl font-semibold tabular-nums">{loadedCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">In Bifrost</p>
            <p className="text-2xl font-semibold tabular-nums">{bifrostCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Machines online</p>
            <p className="text-2xl font-semibold tabular-nums">{machinesOnline}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex-1 min-w-[180px]">
          <label className="text-xs text-muted-foreground">Search</label>
          <Input
            placeholder="Filter by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mt-1 font-mono"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Framework</label>
          <select
            className="mt-1 flex h-9 w-full min-w-[140px] rounded-md border border-border bg-background px-2 text-sm"
            value={fwFilter}
            onChange={(e) => setFwFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="llama-swap">llama-swap</option>
            <option value="tabbyapi">tabbyapi</option>
            <option value="ollama">ollama</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Status</label>
          <select
            className="mt-1 flex h-9 w-full min-w-[140px] rounded-md border border-border bg-background px-2 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="loaded">Loaded</option>
            <option value="bifrost">In Bifrost</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Machine</label>
          <select
            className="mt-1 flex h-9 w-full min-w-[160px] rounded-md border border-border bg-background px-2 text-sm"
            value={machineFilter}
            onChange={(e) => setMachineFilter(e.target.value)}
          >
            <option value="all">All</option>
            {machines.map((m) => (
              <option key={m.id} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {qCatalog.isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {qCatalog.error?.message || 'Failed to load catalog'}
        </div>
      )}

      {qCatalog.isLoading && <TableSkeleton />}

      {!qCatalog.isLoading && !qCatalog.isError && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs">
              <tr>
                <th className="px-3 py-2">{sortLabel('name', 'Name')}</th>
                <th className="px-3 py-2">{sortLabel('machine', 'Machine')}</th>
                <th className="px-3 py-2">{sortLabel('status', 'Status')}</th>
                <th className="px-3 py-2">{sortLabel('bifrost', 'Bifrost')}</th>
                <th className="px-3 py-2">{sortLabel('vram', 'VRAM')}</th>
                <th className="px-3 py-2">{sortLabel('context', 'Context')}</th>
                <th className="px-3 py-2">{sortLabel('quant', 'Quant')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr
                  key={`${m.machine_id}-${m.id}`}
                  className="cursor-pointer border-b border-border/60 hover:bg-muted/30"
                  onClick={() => setSelected(m)}
                >
                  <td className="px-3 py-2 font-mono text-xs">{m.name}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{m.machine_name}</span>
                      <FrameworkBadge framework={m.framework} compact />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {m.is_loaded ? (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600">Loaded</Badge>
                    ) : (
                      <Badge variant="secondary">Available</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {m.in_bifrost ? (
                      <Check className="inline h-4 w-4 text-emerald-500" aria-label="In Bifrost" />
                    ) : (
                      <Minus className="inline h-4 w-4 text-muted-foreground" aria-label="Not in Bifrost" />
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">{formatBytes(m.vram_bytes)}</td>
                  <td className="px-3 py-2 text-xs tabular-nums">{formatCtx(m.ctx_size)}</td>
                  <td className="px-3 py-2">
                    {m.quant ? (
                      <Badge className={cn('font-mono text-xs', quantBadgeClass(m.quant))}>{m.quant}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">No models match the filters.</p>
          )}
        </div>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-base">{selected.name}</SheetTitle>
                <SheetDescription>
                  {selected.machine_name} · {selected.framework}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Catalog id</p>
                  <p className="font-mono text-xs break-all">{selected.id}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Machine</p>
                  <Button variant="link" className="h-auto p-0" asChild>
                    <Link to={`/machines/${encodeURIComponent(selected.machine_id)}`}>
                      Open {selected.machine_name} →
                    </Link>
                  </Button>
                </div>
                {selected.in_bifrost && selected.bifrost_id && (
                  <div>
                    <p className="text-xs text-muted-foreground">Bifrost model id</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded bg-muted px-2 py-1 text-xs">{selected.bifrost_id}</code>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => navigator.clipboard.writeText(selected.bifrost_id)}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-xs text-muted-foreground">VRAM</p>
                    <p>{formatBytes(selected.vram_bytes)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Context</p>
                    <p>{formatCtx(selected.ctx_size)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Quant</p>
                    <p>{selected.quant || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Loaded</p>
                    <p>{selected.is_loaded ? 'Yes' : 'No'}</p>
                  </div>
                </div>
                {selected.framework === 'llama-swap' && selected.cmd && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Command</p>
                    <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">
                      {selected.cmd}
                    </pre>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-2">
                  {selected.framework === 'llama-swap' && (
                    <Button
                      size="sm"
                      disabled={warmMut.isPending}
                      onClick={() => warmMut.mutate({ id: selected.machine_id, name: selected.name })}
                    >
                      {warmMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Warm
                    </Button>
                  )}
                  {selected.framework === 'tabbyapi' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={tabbyLoadMut.isPending}
                      onClick={() => tabbyLoadMut.mutate({ id: selected.machine_id, name: selected.name })}
                    >
                      {tabbyLoadMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Load
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
