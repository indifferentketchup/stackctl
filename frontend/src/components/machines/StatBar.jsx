import { cn } from '@/lib/utils.js'

function formatNum(value) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  return Number(value).toFixed(1)
}

export function StatBar({ label, value = null, max = null, unit = '', pct = null, colorClass = 'bg-primary' }) {
  const safePct = pct == null || Number.isNaN(Number(pct)) ? null : Math.min(100, Math.max(0, Number(pct)))
  const width = safePct == null ? '0%' : `${safePct}%`
  const valueText =
    value == null
      ? '—'
      : max == null
        ? `${formatNum(value)}${unit ? ` ${unit}` : ''}`
        : `${formatNum(value)}/${formatNum(max)}${unit ? ` ${unit}` : ''}`

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{valueText}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full transition-[width]', colorClass)} style={{ width }} />
        </div>
        <span className="w-11 text-right text-xs text-muted-foreground">
          {safePct == null ? '—' : `${Math.round(safePct)}%`}
        </span>
      </div>
    </div>
  )
}
