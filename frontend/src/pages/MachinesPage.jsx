import { useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Loader2, Plus } from 'lucide-react'
import { createMachine, getMachineHealth, getMachines, getMachineSsh, getMachineStatus, uploadSshKey } from '@/api/machines.js'
import { apiFetch } from '@/api/client.js'
import { FrameworkBadge } from '@/components/machines/FrameworkBadge.jsx'
import { MachineStatusDots } from '@/components/machines/MachineStatusDots.jsx'
import { StatBar } from '@/components/machines/StatBar.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'

function osIcon(os) {
  const k = String(os || '').toLowerCase()
  if (k === 'windows') return '🪟'
  if (k === 'ubuntu') return '🐧'
  return '⚙️'
}

function roundGb(bytesValue) {
  if (bytesValue == null || Number.isNaN(Number(bytesValue))) return null
  return Number(bytesValue) / (1024 * 1024 * 1024)
}

function StatSkeleton() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      <div className="h-1.5 w-full animate-pulse rounded bg-muted" />
    </div>
  )
}

function AddMachineDialog({ onCreated }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [keyMode, setKeyMode] = useState('upload')
  const [file, setFile] = useState(null)
  const [form, setForm] = useState({
    name: '',
    ip: '',
    os: 'ubuntu',
    ssh_user: '',
    ssh_filename: '',
    ssh_content: '',
    prom_job: '',
    gpu_prom_job: '',
    framework: 'none',
    framework_url: '',
    framework_config_path: '',
    framework_restart_cmd: '',
  })

  const createMut = useMutation({
    mutationFn: async () => {
      let sshKeyPath = null
      if (keyMode === 'upload' && file) {
        const fd = new FormData()
        fd.append('file', file)
        const uploaded = await uploadSshKey(fd)
        sshKeyPath = uploaded?.path || null
      } else if (keyMode === 'paste' && form.ssh_filename.trim() && form.ssh_content.trim()) {
        const uploaded = await apiFetch('/api/machines/ssh-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: form.ssh_filename.trim(),
            content: form.ssh_content,
          }),
        })
        sshKeyPath = uploaded?.path || null
      }

      const body = {
        name: form.name.trim(),
        ip: form.ip.trim(),
        os: form.os,
        ssh_user: form.ssh_user.trim(),
        ssh_key_path: sshKeyPath,
        prom_job: form.prom_job.trim() || null,
        gpu_prom_job: form.gpu_prom_job.trim() || null,
        framework: form.framework,
        framework_url: form.framework_url.trim() || null,
        framework_config_path: form.framework_config_path.trim() || null,
        framework_restart_cmd: form.framework_restart_cmd.trim() || null,
      }
      return createMachine(body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] })
      setOpen(false)
      onCreated?.()
    },
  })

  const showFrameworkExtras = form.framework === 'llama-swap' || form.framework === 'tabbyapi'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> Add Machine
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Machine</DialogTitle>
          <DialogDescription>Register a host for monitoring and framework controls.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            createMut.mutate()
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input required value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>IP</Label>
              <Input required value={form.ip} onChange={(e) => setForm((p) => ({ ...p, ip: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>OS</Label>
              <select
                className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={form.os}
                onChange={(e) => setForm((p) => ({ ...p, os: e.target.value }))}
              >
                <option value="ubuntu">Ubuntu Server</option>
                <option value="windows">Windows</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>SSH User</Label>
              <Input
                required
                value={form.ssh_user}
                onChange={(e) => setForm((p) => ({ ...p, ssh_user: e.target.value }))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>SSH Key</Label>
            <Tabs value={keyMode} onValueChange={setKeyMode}>
              <TabsList>
                <TabsTrigger value="upload">Upload File</TabsTrigger>
                <TabsTrigger value="paste">Paste Text</TabsTrigger>
              </TabsList>
              <TabsContent value="upload" className="space-y-1.5">
                <Input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </TabsContent>
              <TabsContent value="paste" className="space-y-2">
                <Input
                  placeholder="id_rsa"
                  value={form.ssh_filename}
                  onChange={(e) => setForm((p) => ({ ...p, ssh_filename: e.target.value }))}
                />
                <Textarea
                  className="min-h-[120px] font-mono-ui text-xs"
                  value={form.ssh_content}
                  onChange={(e) => setForm((p) => ({ ...p, ssh_content: e.target.value }))}
                />
              </TabsContent>
            </Tabs>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Prom Job</Label>
              <Input
                placeholder="node-exporter"
                value={form.prom_job}
                onChange={(e) => setForm((p) => ({ ...p, prom_job: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>GPU Prom Job</Label>
              <Input
                placeholder="dcgm or nvidia_gpu_exporter_desktop"
                value={form.gpu_prom_job}
                onChange={(e) => setForm((p) => ({ ...p, gpu_prom_job: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Framework</Label>
              <select
                className="flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={form.framework}
                onChange={(e) => setForm((p) => ({ ...p, framework: e.target.value }))}
              >
                <option value="none">none</option>
                <option value="llama-swap">llama-swap</option>
                <option value="tabbyapi">tabbyapi</option>
                <option value="ollama">ollama</option>
                <option value="infinity-emb">infinity-emb</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Framework URL</Label>
              <Input
                placeholder="http://IP:PORT"
                value={form.framework_url}
                onChange={(e) => setForm((p) => ({ ...p, framework_url: e.target.value }))}
              />
            </div>
          </div>

          {showFrameworkExtras && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Config Path</Label>
                <Input
                  value={form.framework_config_path}
                  onChange={(e) => setForm((p) => ({ ...p, framework_config_path: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Restart Command</Label>
                <Input
                  value={form.framework_restart_cmd}
                  onChange={(e) => setForm((p) => ({ ...p, framework_restart_cmd: e.target.value }))}
                />
              </div>
            </div>
          )}

          {createMut.isError && (
            <p className="text-sm text-destructive">{createMut.error?.message || 'Create failed'}</p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function MachinesPage() {
  const qList = useQuery({
    queryKey: ['machines'],
    queryFn: getMachines,
  })
  const machines = qList.data?.machines ?? []

  const statusQueries = useQueries({
    queries: machines.map((m) => ({
      queryKey: ['machine-status', m.id],
      queryFn: () => getMachineStatus(m.id),
      refetchInterval: 30_000,
    })),
  })
  const healthQueries = useQueries({
    queries: machines.map((m) => ({
      queryKey: ['machine-health', m.id],
      queryFn: () => getMachineHealth(m.id),
      refetchInterval: 60_000,
    })),
  })
  const sshQueries = useQueries({
    queries: machines.map((m) => ({
      queryKey: ['machine-ssh', m.id],
      queryFn: () => getMachineSsh(m.id),
      refetchInterval: 60_000,
    })),
  })

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Machines</h1>
        <AddMachineDialog />
      </header>

      {qList.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading machines...
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {machines.map((m, idx) => {
          const statusQ = statusQueries[idx]
          const healthQ = healthQueries[idx]
          const sshQ = sshQueries[idx]
          const status = statusQ?.data || {}
          const gpu = status?.gpu || null
          const vramUsed = roundGb(gpu?.vram_used_bytes)
          const vramTotal = roundGb(gpu?.vram_total_bytes)
          return (
            <Card key={m.id}>
              <CardHeader className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-xl font-bold">
                    {m.name} <span className="ml-1 text-base">{osIcon(m.os)}</span>
                  </CardTitle>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <FrameworkBadge framework={m.framework} />
                  <MachineStatusDots sshOk={sshQ?.data?.ok} frameworkOk={healthQ?.data?.ok} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {statusQ?.isLoading ? (
                  <div className="space-y-3">
                    <StatSkeleton />
                    <StatSkeleton />
                    <StatSkeleton />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <StatBar label="CPU" pct={status?.cpu_pct} />
                    <StatBar
                      label="RAM"
                      value={status?.ram_total_gb != null && status?.ram_pct != null ? (status.ram_total_gb * status.ram_pct) / 100 : null}
                      max={status?.ram_total_gb}
                      unit="GB"
                      pct={status?.ram_pct}
                    />
                    <StatBar label="Disk" pct={status?.disk_pct} />
                    {gpu && (
                      <StatBar
                        label="VRAM"
                        value={vramUsed}
                        max={vramTotal}
                        unit="GB"
                        pct={gpu?.vram_total_bytes ? (Number(gpu?.vram_used_bytes || 0) / Number(gpu.vram_total_bytes)) * 100 : null}
                        colorClass="bg-purple-500"
                      />
                    )}
                    {gpu && gpu.util_pct != null && (
                      <p className="text-xs text-muted-foreground">
                        GPU {Math.round(Number(gpu.util_pct))}% · {gpu.temp_c == null ? '—' : `${Math.round(Number(gpu.temp_c))}°C`}
                      </p>
                    )}
                  </div>
                )}

                <Button variant="outline" size="sm" asChild>
                  <Link to={`/machines/${encodeURIComponent(m.id)}`}>Open</Link>
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
