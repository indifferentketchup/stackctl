import { cn } from '@/lib/utils'

export function Progress({ value = 0, className }) {
  const v = Math.min(100, Math.max(0, Number(value) || 0))
  return (
    <div
      className={cn('h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
      role="progressbar"
      aria-valuenow={v}
    >
      <div
        className="h-full bg-primary transition-[width] duration-300"
        style={{ width: `${v}%` }}
      />
    </div>
  )
}
