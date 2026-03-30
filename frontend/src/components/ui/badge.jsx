import { cn } from '@/lib/utils'

export function Badge({ className, variant = 'default', ...props }) {
  const variants = {
    default: 'border-transparent bg-primary/90 text-primary-foreground',
    secondary: 'border-transparent bg-secondary text-secondary-foreground',
    outline: 'text-foreground border-border',
    amber: 'border-amber-500/50 bg-amber-500/15 text-amber-200',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold',
        variants[variant] || variants.default,
        className
      )}
      {...props}
    />
  )
}
