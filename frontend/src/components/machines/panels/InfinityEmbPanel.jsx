import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { getMachineById, getMachineHealth, restartFramework } from '@/api/machines.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'

export function InfinityEmbPanel({ machineId }) {
  const qc = useQueryClient()
  const [stopHint, setStopHint] = useState('')
  const stopCommand = 'sudo systemctl stop infinity-emb'

  const qHealth = useQuery({
    queryKey: ['machine-health', machineId],
    queryFn: () => getMachineHealth(machineId),
    enabled: !!machineId,
    refetchInterval: 30_000,
  })
  const qMachine = useQuery({
    queryKey: ['machine', machineId],
    queryFn: () => getMachineById(machineId),
    enabled: !!machineId,
  })

  const restartMut = useMutation({
    mutationFn: () => restartFramework(machineId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machine-health', machineId] })
    },
  })

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      setStopHint('Copied to clipboard.')
    } catch {
      setStopHint('Copy failed.')
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service status</CardTitle>
        </CardHeader>
        <CardContent>
          {qHealth.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking service...
            </div>
          ) : (
            <Badge className={qHealth.data?.ok ? 'bg-emerald-600 text-white' : 'bg-destructive text-destructive-foreground'}>
              {qHealth.data?.ok ? 'Running' : 'Unreachable'}
            </Badge>
          )}
          {qHealth.isError ? <p className="mt-2 text-sm text-destructive">{qHealth.error?.message}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => restartMut.mutate()} disabled={restartMut.isPending}>
              {restartMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Start
            </Button>
            <Button
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10"
              onClick={() => setStopHint('Use SSH to stop infinity-emb manually')}
            >
              Stop
            </Button>
            <Button variant="outline" onClick={() => restartMut.mutate()} disabled={restartMut.isPending}>
              {restartMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Restart
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 p-2">
            <code className="font-mono text-xs">{stopCommand}</code>
            <Button size="sm" variant="outline" onClick={() => copyText(stopCommand)}>
              Copy
            </Button>
          </div>
          {stopHint ? <p className="text-sm text-muted-foreground">{stopHint}</p> : null}
          {restartMut.isError ? <p className="text-sm text-destructive">{restartMut.error?.message}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={qMachine.data?.framework_url || '#'}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-blue-400 hover:underline"
            >
              {qMachine.data?.framework_url || 'No framework URL configured'}
            </a>
            {qMachine.data?.framework_url ? (
              <Button size="sm" variant="outline" onClick={() => copyText(qMachine.data.framework_url)}>
                Copy URL
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">infinity-emb does not support config editing via this UI</p>
        </CardContent>
      </Card>
    </div>
  )
}
