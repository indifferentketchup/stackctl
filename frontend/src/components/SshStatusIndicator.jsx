import { useEffect, useState } from 'react'
import { fetchMachinesSshStatus } from '@/api/machines.js'
import { cn } from '@/lib/utils.js'

/** Polls SSH reachability for each configured GPU host (Tailscale + keys). */
export function SshStatusIndicator({ className }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const j = await fetchMachinesSshStatus()
        if (!cancelled) setData(j)
      } catch {
        if (!cancelled) setData({ machines: [], error: 'request failed' })
      }
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const machines = data?.machines || []
  const err = data?.error

  if (data === null) {
    return (
      <span className={cn('inline-flex items-center gap-2 text-xs text-muted-foreground animate-pulse', className)}>
        <span className="h-2 w-2 rounded-full bg-muted-foreground" aria-hidden />
        Checking SSH…
      </span>
    )
  }

  if (err && !machines.length) {
    return (
      <span className={cn('inline-flex items-center gap-2 text-xs text-muted-foreground', className)} title={err}>
        <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden />
        <span>SSH status unavailable</span>
      </span>
    )
  }

  if (!machines.length) {
    return (
      <span className={cn('text-xs text-muted-foreground', className)} title="Set SAMDESKTOP_* and GPU_* in .env">
        No SSH hosts configured
      </span>
    )
  }

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}>
      {machines.map((m) => (
        <span
          key={m.id}
          className="inline-flex items-center gap-1.5"
          title={m.connected ? 'SSH OK' : 'SSH failed'}
        >
          <span
            className={cn('h-2 w-2 rounded-full', m.connected ? 'bg-emerald-500' : 'bg-red-500')}
            aria-hidden
          />
          <span>{m.id}</span>
        </span>
      ))}
    </span>
  )
}
