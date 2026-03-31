import { useEffect, useState } from 'react'
import { fetchSshStatus } from '@/api/models.js'
import { cn } from '@/lib/utils.js'

export function SshStatusIndicator({ className }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const j = await fetchSshStatus()
        if (!cancelled) setData(j)
      } catch {
        if (!cancelled)
          setData({
            connected: false,
            host: '',
            user: '',
            error: 'request failed',
          })
      }
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const ok = data?.connected
  const label = ok ? 'sam-desktop connected' : 'sam-desktop unreachable'
  const tip =
    data == null
      ? 'Checking SSH…'
      : `${data.host || '—'} · ${data.user || '—'}${data.error && !ok ? ` · ${data.error}` : ''}`

  return (
    <span
      className={cn('inline-flex items-center gap-2 text-xs text-muted-foreground', className)}
      title={tip}
    >
      <span
        className={cn('h-2 w-2 rounded-full', ok ? 'bg-green-500' : 'bg-red-500', data == null && 'animate-pulse bg-muted-foreground')}
        aria-hidden
      />
      <span>{label}</span>
    </span>
  )
}
