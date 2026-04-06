import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ExternalLink, Loader2, Server } from 'lucide-react'
import { listMachines, getMachineStatus } from '@/api/machines.js'
import { getLlamaSwapRunning } from '@/api/llamaswap.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { cn } from '@/lib/utils.js'

function mibValueFromSmi(s) {
  const m = String(s ?? '').match(/([\d.]+)/)
  return m ? Number.parseFloat(m[1]) : NaN
}

function VramUseBar({ usedMibStr, freeMibStr }) {
  const usedMib = mibValueFromSmi(usedMibStr)
  const freeMib = mibValueFromSmi(freeMibStr)
  const totalMib = Number.isFinite(usedMib) && Number.isFinite(freeMib) ? usedMib + freeMib : NaN
  const pct =
    Number.isFinite(totalMib) && totalMib > 0 ? Math.min(100, Math.max(0, (usedMib / totalMib) * 100)) : null
  const usedGb = Number.isFinite(usedMib) ? usedMib / 1024 : null
  const totalGb = Number.isFinite(totalMib) ? totalMib / 1024 : null
  const barClass =
    pct == null ? 'bg-muted' : pct < 70 ? 'bg-emerald-500' : pct <= 90 ? 'bg-amber-500' : 'bg-red-500'

  return (
    <div className="mt-2 space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-[width]', barClass)}
          style={{ width: pct == null ? '0%' : `${pct}%` }}
        />
      </div>
      <div className="text-[11px] text-muted-foreground">
        {usedGb != null && totalGb != null
          ? `${usedGb.toFixed(1)} GB / ${totalGb.toFixed(1)} GB`
          : `${usedMibStr} · ${freeMibStr}`}
      </div>
    </div>
  )
}

export function MachinesPage() {
  const qList = useQuery({
    queryKey: ['machines'],
    queryFn: listMachines,
    refetchInterval: 60_000,
  })

  const machines = qList.data?.machines ?? []

  const statusQueries = useQueries({
    queries: machines.map((m) => ({
      queryKey: ['machine-status', m.id],
      queryFn: () => getMachineStatus(m.id, false),
      refetchInterval: 30_000,
      enabled: !!m.id,
    })),
  })

  const runningQueries = useQueries({
    queries: machines.map((m) => ({
      queryKey: ['llamaswap-running', m.id],
      queryFn: () => getLlamaSwapRunning(m.id),
      refetchInterval: 15_000,
      enabled: !!m.id,
      retry: false,
    })),
  })

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold">Machines</h1>
        <p className="text-sm text-muted-foreground">
          GPU hosts over SSH (<code className="font-mono-ui text-xs">nvidia-smi</code>) and llama-swap config per host.
        </p>
      </header>

      {qList.isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {machines.map((m, i) => {
          const sq = statusQueries[i]
          const st = sq?.data
          const sshOk = st?.ssh_ok
          const rq = runningQueries[i]
          const loaded = rq?.data?.loaded_model ?? null
          return (
            <Card key={m.id}>
              <CardHeader className="space-y-1">
                <div className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-primary" />
                  <CardTitle className="text-lg">{m.name}</CardTitle>
                  <Badge
                    variant="outline"
                    className={cn(
                      sshOk === true && 'border-emerald-500/50 text-emerald-600',
                      sshOk === false && 'border-red-500/50 text-red-600'
                    )}
                  >
                    {sq?.isLoading ? '…' : sshOk ? 'SSH OK' : 'SSH / GPU'}
                  </Badge>
                </div>
                <CardDescription className="font-mono-ui text-xs break-all">
                  {m.ssh_user}@{m.ssh_host} · {m.platform}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Currently loaded</span>
                  {rq?.isLoading && <span className="text-muted-foreground">…</span>}
                  {rq?.isError && <span className="text-muted-foreground/70">unknown</span>}
                  {!rq?.isLoading && !rq?.isError && !loaded && (
                    <span className="text-muted-foreground/60">idle</span>
                  )}
                  {!rq?.isLoading && !rq?.isError && loaded && (
                    <Badge variant="secondary" className="max-w-full truncate font-mono-ui text-[11px]">
                      {loaded}
                    </Badge>
                  )}
                </div>
                {st?.stderr && (
                  <p className="text-xs text-destructive whitespace-pre-wrap break-all">{st.stderr}</p>
                )}
                {Array.isArray(st?.gpu) && st.gpu.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {st.gpu.map((g, j) => (
                      <li key={j} className="rounded-md border border-border/80 bg-muted/20 px-3 py-2">
                        <div className="font-medium">{g.name}</div>
                        <VramUseBar usedMibStr={g.memory_used_mib} freeMibStr={g.memory_free_mib} />
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span>Temp: {g.temperature_c}°C</span>
                          <span>Util: {g.utilization_percent}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  !sq?.isLoading && (
                    <p className="text-xs text-muted-foreground">
                      {sshOk === false ? 'No GPU telemetry (check NVIDIA drivers / nvidia-smi).' : '—'}
                    </p>
                  )
                )}
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/llamaswap/${encodeURIComponent(m.id)}`} className="inline-flex items-center gap-2">
                    llama-swap config <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {!qList.isLoading && machines.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Configure <code className="font-mono-ui text-xs">SAMDESKTOP_HOST</code>,{' '}
          <code className="font-mono-ui text-xs">GPU_HOST</code>, and matching users in the API{' '}
          <code className="font-mono-ui text-xs">.env</code>.
        </p>
      )}
    </div>
  )
}
