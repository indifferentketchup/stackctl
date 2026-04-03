import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Loader2, Server, Unlink } from 'lucide-react'
import {
  deleteAssignment,
  listMachineAssignments,
  listMachines,
  upsertAssignment,
} from '@/api/machines.js'
import { getRunning } from '@/api/ollama.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { cn } from '@/lib/utils.js'

export function MachinesPage() {
  const qc = useQueryClient()
  const [assignModel, setAssignModel] = useState('')
  const [assignMachineId, setAssignMachineId] = useState('')

  const qMachines = useQuery({
    queryKey: ['machines'],
    queryFn: listMachines,
    refetchInterval: 30_000,
  })

  const qAssignments = useQuery({
    queryKey: ['machine-assignments'],
    queryFn: listMachineAssignments,
  })

  const machines = qMachines.data?.machines ?? []
  const assignments = qAssignments.data?.assignments ?? []

  const byMachine = useMemo(() => {
    const m = {}
    for (const mach of machines) {
      m[mach.id] = []
    }
    for (const a of assignments) {
      if (m[a.machine_id]) m[a.machine_id].push(a)
    }
    return m
  }, [machines, assignments])

  const saveMut = useMutation({
    mutationFn: ({ model_name, machine_id }) => upsertAssignment(model_name, machine_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machine-assignments'] })
      qc.invalidateQueries({ queryKey: ['ollama', 'models'] })
      setAssignModel('')
    },
  })

  const unassignMut = useMutation({
    mutationFn: (model_name) => deleteAssignment(model_name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machine-assignments'] })
      qc.invalidateQueries({ queryKey: ['ollama', 'models'] })
    },
  })

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold">Machines</h1>
        <p className="text-sm text-muted-foreground">
          Ollama hosts, SSH type, and per-model routing for boolab. Status refreshes every 30 seconds.
        </p>
      </header>

      {qMachines.isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading machines…
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {machines.map((m) => (
          <MachineCard
            key={m.id}
            machine={m}
            assigned={byMachine[m.id] ?? []}
            onUnassign={(model) => unassignMut.mutate(model)}
            unassignPending={unassignMut.isPending}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All assignments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              const mid = parseInt(assignMachineId, 10)
              if (!assignModel.trim() || !Number.isFinite(mid)) return
              saveMut.mutate({ model_name: assignModel.trim(), machine_id: mid })
            }}
          >
            <div className="flex-1 min-w-[200px]">
              <Label>Model name</Label>
              <Input
                className="mt-1 font-mono-ui text-sm"
                placeholder="e.g. qwen3.5:9b"
                value={assignModel}
                onChange={(e) => setAssignModel(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-48">
              <Label>Machine</Label>
              <select
                className="mt-1 flex h-10 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={assignMachineId}
                onChange={(e) => setAssignMachineId(e.target.value)}
              >
                <option value="">Select…</option>
                {machines.map((m) => (
                  <option key={m.id} value={String(m.id)}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={saveMut.isPending || !assignModel.trim() || !assignMachineId}>
              {saveMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save assignment
            </Button>
          </form>

          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-card/80 text-muted-foreground">
                  <th className="p-2 font-semibold">Model</th>
                  <th className="p-2 font-semibold">Machine</th>
                  <th className="p-2 w-[100px]" />
                </tr>
              </thead>
              <tbody>
                {assignments.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-4 text-muted-foreground text-center">
                      No assignments yet.
                    </td>
                  </tr>
                )}
                {assignments.map((a) => (
                  <tr key={a.id} className="border-b border-border/60">
                    <td className="p-2 font-mono-ui text-xs">{a.model_name}</td>
                    <td className="p-2">{a.machine_name}</td>
                    <td className="p-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        disabled={unassignMut.isPending}
                        onClick={() => unassignMut.mutate(a.model_name)}
                      >
                        <Unlink className="h-4 w-4" />
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        boolab resolves inference via{' '}
        <code className="font-mono-ui">GET /api/machines/route/&lt;model&gt;</code> on this API. Assign every model you use in chat.
      </p>
    </div>
  )
}

function MachineCard({ machine, assigned, onUnassign, unassignPending }) {
  const qRun = useQuery({
    queryKey: ['ollama-running', 'machine', machine.id],
    queryFn: () => getRunning(machine.id),
    enabled: machine.reachable === true,
    refetchInterval: 30_000,
  })
  const nRun =
    machine.reachable && Array.isArray(qRun.data?.models) ? qRun.data.models.length : machine.running_count ?? 0

  const st = String(machine.ssh_type || 'nssm').toLowerCase()

  return (
    <Card>
      <CardHeader className="space-y-1 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Server className="h-5 w-5 shrink-0 text-primary" />
            <CardTitle className="text-lg font-bold truncate">{machine.name}</CardTitle>
          </div>
          <span
            className={cn(
              'h-2.5 w-2.5 shrink-0 rounded-full mt-1.5',
              machine.reachable ? 'bg-emerald-500' : 'bg-red-500',
            )}
            title={machine.reachable ? 'Reachable' : 'Unreachable'}
          />
        </div>
        {machine.gpu_label ? (
          <p className="text-sm text-muted-foreground">{machine.gpu_label}</p>
        ) : null}
        <p className="font-mono-ui text-xs text-muted-foreground break-all">{machine.ollama_url}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge variant="secondary">{st === 'systemd' ? 'systemd' : 'NSSM'}</Badge>
          <Badge variant="outline">
            {machine.reachable ? `${nRun} running` : 'offline'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Assigned models
        </div>
        {assigned.length === 0 ? (
          <p className="text-sm text-muted-foreground">None</p>
        ) : (
          <ul className="space-y-1">
            {assigned.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2 font-mono-ui text-xs border border-border rounded px-2 py-1"
              >
                <span className="truncate">{a.model_name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-destructive shrink-0"
                  disabled={unassignPending}
                  onClick={() => onUnassign(a.model_name)}
                >
                  Unassign
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" size="sm" className="mt-2" asChild>
          <Link to={`/gpu?machine=${machine.id}`}>GPU / env (this host)</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
