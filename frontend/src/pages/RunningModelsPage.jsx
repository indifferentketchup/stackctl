import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, Loader2 } from 'lucide-react'
import { getRunning, unloadModel } from '@/api/ollama.js'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx'

function formatBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (v < 1024) return `${v} B`
  const kb = v / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(2)} GB`
}

function parseExpiry(expiresAt) {
  if (expiresAt == null) return null
  if (typeof expiresAt === 'string') {
    const d = Date.parse(expiresAt)
    if (!Number.isNaN(d)) return d
  }
  if (typeof expiresAt === 'number') {
    if (expiresAt > 1e12) return expiresAt
    if (expiresAt > 1e9) return expiresAt * 1000
  }
  return null
}

function Countdown({ until }) {
  const [left, setLeft] = useState(() => (until ? until - Date.now() : null))

  useEffect(() => {
    if (!until) {
      setLeft(null)
      return
    }
    const t = setInterval(() => setLeft(until - Date.now()), 500)
    setLeft(until - Date.now())
    return () => clearInterval(t)
  }, [until])

  if (left == null || until == null) return <span className="text-muted-foreground">—</span>
  if (left <= 0) return <span className="text-muted-foreground">Unloading…</span>
  const s = Math.floor(left / 1000)
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const rm = m % 60
    return (
      <span>
        {h}h {rm}m
      </span>
    )
  }
  if (m > 0) return <span>{m}m {rs}s</span>
  return <span>{s}s</span>
}

export function RunningModelsPage() {
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['ollama-running'],
    queryFn: getRunning,
    refetchInterval: 10_000,
    retry: false,
  })

  const unMut = useMutation({
    mutationFn: (name) => unloadModel(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ollama-running'] }),
  })

  const models = data?.models
  const list = Array.isArray(models) ? models : []

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Running Models</h1>
        <p className="text-sm text-muted-foreground">
          Models loaded in VRAM (refreshes every 10 seconds).
        </p>
      </header>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading…
        </div>
      )}

      {isError && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="py-4 text-sm text-destructive">
            Could not load running models. Set <code className="font-mono-ui">boolab_owner_token</code> in
            localStorage to match <code className="font-mono-ui">BOOLAB_OWNER_TOKEN</code>, or set{' '}
            <code className="font-mono-ui">OLLAMACTL_SKIP_AUTH=1</code> on the API for local dev.{' '}
            {error?.message ? `(${error.message})` : ''}
          </CardContent>
        </Card>
      )}

      {!isLoading && list.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No models currently loaded in VRAM.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {list.map((m) => {
          const name = m.name || m.model || 'unknown'
          const exp = parseExpiry(m.expires_at)
          const vram = m.size_vram ?? m.vram ?? m.size
          return (
            <Card key={name}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <CardTitle className="font-mono-ui text-base break-all">{name}</CardTitle>
                <Cpu className="h-5 w-5 shrink-0 text-primary opacity-80" />
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">VRAM</span>
                  <span className="font-medium">{formatBytes(vram)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Time left</span>
                  <span className="font-medium">
                    <Countdown until={exp} />
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={unMut.isPending}
                  onClick={() => unMut.mutate(name)}
                >
                  Unload
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
