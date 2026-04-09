import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { getMachineById, getMachineHealth, getMachineSsh, getMachineStatus } from '@/api/machines.js'
import { FrameworkBadge } from '@/components/machines/FrameworkBadge.jsx'
import { MachineStatusDots } from '@/components/machines/MachineStatusDots.jsx'
import { StatBar } from '@/components/machines/StatBar.jsx'
import { InfinityEmbPanel } from '@/components/machines/panels/InfinityEmbPanel.jsx'
import { LlamaSwapPanel } from '@/components/machines/panels/LlamaSwapPanel.jsx'
import { OllamaPanel } from '@/components/machines/panels/OllamaPanel.jsx'
import { TabbyApiPanel } from '@/components/machines/panels/TabbyApiPanel.jsx'
import { Badge } from '@/components/ui/badge.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'

function osLabel(os) {
  const k = String(os || 'other').toLowerCase()
  if (k === 'windows') return 'Windows'
  if (k === 'ubuntu') return 'Ubuntu'
  return 'Other'
}

function gb(bytesValue) {
  if (bytesValue == null || Number.isNaN(Number(bytesValue))) return null
  return Number(bytesValue) / (1024 * 1024 * 1024)
}

function frameworkPanel(framework, machineId) {
  if (framework === 'llama-swap') return <LlamaSwapPanel machineId={machineId} />
  if (framework === 'tabbyapi') return <TabbyApiPanel machineId={machineId} />
  if (framework === 'ollama') return <OllamaPanel machineId={machineId} />
  if (framework === 'infinity-emb') return <InfinityEmbPanel machineId={machineId} />
  return <p className="text-muted-foreground">No framework configured.</p>
}

export function MachineDetailPage() {
  const { id } = useParams()
  const machineId = id ? decodeURIComponent(id) : ''

  const qMachine = useQuery({
    queryKey: ['machine', machineId],
    queryFn: () => getMachineById(machineId),
    enabled: !!machineId,
  })
  const qStatus = useQuery({
    queryKey: ['machine-status', machineId],
    queryFn: () => getMachineStatus(machineId),
    enabled: !!machineId,
    refetchInterval: 30_000,
  })
  const qHealth = useQuery({
    queryKey: ['machine-health', machineId],
    queryFn: () => getMachineHealth(machineId),
    enabled: !!machineId,
    refetchInterval: 60_000,
  })
  const qSsh = useQuery({
    queryKey: ['machine-ssh', machineId],
    queryFn: () => getMachineSsh(machineId),
    enabled: !!machineId,
    refetchInterval: 60_000,
  })

  if (qMachine.isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading machine...
      </div>
    )
  }

  const machine = qMachine.data
  const status = qStatus.data || {}
  const gpu = status?.gpu || null

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link to="/machines" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Machines
      </Link>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{machine?.name || machineId}</h1>
        <Badge variant="outline">{osLabel(machine?.os)}</Badge>
        <FrameworkBadge framework={machine?.framework} />
        <MachineStatusDots sshOk={qSsh.data?.ok} frameworkOk={qHealth.data?.ok} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatBar label="CPU" pct={status?.cpu_pct} />
        <StatBar
          label="RAM"
          value={status?.ram_total_gb != null && status?.ram_pct != null ? (status.ram_total_gb * status.ram_pct) / 100 : null}
          max={status?.ram_total_gb}
          unit="GB"
          pct={status?.ram_pct}
        />
        <StatBar label="Disk" pct={status?.disk_pct} />
        {gpu ? (
          <StatBar
            label="VRAM"
            value={gb(gpu?.vram_used_bytes)}
            max={gb(gpu?.vram_total_bytes)}
            unit="GB"
            pct={gpu?.vram_total_bytes ? (Number(gpu?.vram_used_bytes || 0) / Number(gpu.vram_total_bytes)) * 100 : null}
            colorClass="bg-purple-500"
          />
        ) : (
          <StatBar label="VRAM" value={null} />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Framework</CardTitle>
        </CardHeader>
        <CardContent>{frameworkPanel(String(machine?.framework || 'none').toLowerCase(), machineId)}</CardContent>
      </Card>
    </div>
  )
}
