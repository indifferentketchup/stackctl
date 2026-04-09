import { cn } from '@/lib/utils.js'

function dotClass(ok) {
  if (ok == null) return 'bg-muted-foreground/40'
  return ok ? 'bg-emerald-500' : 'bg-red-500'
}

export function MachineStatusDots({ sshOk, frameworkOk }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn('h-2 w-2 rounded-full', dotClass(sshOk))} title="SSH" aria-label="SSH status" />
      <span
        className={cn('h-2 w-2 rounded-full', dotClass(frameworkOk))}
        title="Framework"
        aria-label="Framework status"
      />
    </div>
  )
}
