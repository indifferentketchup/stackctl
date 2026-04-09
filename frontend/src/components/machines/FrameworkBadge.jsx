import { Badge } from '@/components/ui/badge.jsx'
import { cn } from '@/lib/utils.js'

const COLORS = {
  'llama-swap': 'text-blue-600',
  tabbyapi: 'text-purple-600',
  ollama: 'text-emerald-600',
  'infinity-emb': 'text-orange-600',
  none: 'text-muted-foreground',
}

export function FrameworkBadge({ framework, compact = false }) {
  const name = (framework || 'none').toLowerCase()
  const colorClass = COLORS[name] || COLORS.none

  if (compact) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs', colorClass)}>
        <span className={cn('h-1.5 w-1.5 rounded-full bg-current')} />
        <span>{name}</span>
      </span>
    )
  }

  return (
    <Badge variant="outline" className={cn('gap-1.5', colorClass)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span>{name}</span>
    </Badge>
  )
}
