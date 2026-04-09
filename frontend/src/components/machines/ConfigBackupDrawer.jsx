import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { getConfigBackup, getConfigBackups, getMachineById, restoreConfigBackup } from '@/api/machines.js'
import { Button } from '@/components/ui/button.jsx'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet.jsx'

function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

function formatBackupTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function ConfigBackupDrawer({ machineId, open, onClose, onRestore }) {
  const [previewId, setPreviewId] = useState(null)
  const [previewText, setPreviewText] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const previewRequestRef = useRef(0)

  const qMachine = useQuery({
    queryKey: ['machine', machineId],
    queryFn: () => getMachineById(machineId),
    enabled: open && !!machineId,
  })

  const qBackups = useQuery({
    queryKey: ['config-backups', machineId],
    queryFn: () => getConfigBackups(machineId),
    enabled: open && !!machineId,
  })

  const restoreMut = useMutation({
    mutationFn: ({ backupId }) => restoreConfigBackup(machineId, backupId),
    onSuccess: () => {
      onRestore?.()
      onClose?.()
    },
  })

  const backups = Array.isArray(qBackups.data?.backups) ? qBackups.data.backups : []

  const handleOpenChange = (next) => {
    if (!next) {
      previewRequestRef.current += 1
      setPreviewId(null)
      setPreviewText(null)
      setPreviewError(null)
      onClose?.()
    }
  }

  const handlePreview = async (bid) => {
    if (previewId === bid && previewText != null) {
      previewRequestRef.current += 1
      setPreviewId(null)
      setPreviewText(null)
      setPreviewError(null)
      return
    }
    const req = previewRequestRef.current + 1
    previewRequestRef.current = req
    setPreviewId(bid)
    setPreviewText(null)
    setPreviewError(null)
    try {
      const data = await getConfigBackup(machineId, bid)
      if (previewRequestRef.current !== req) return
      setPreviewText(typeof data?.yaml_text === 'string' ? data.yaml_text : '')
    } catch (e) {
      if (previewRequestRef.current !== req) return
      setPreviewError(e?.message || 'Failed to load backup')
    }
  }

  const handleRestore = (bid) => {
    if (
      !window.confirm(
        'Restore this backup? Current config will be backed up first.'
      )
    ) {
      return
    }
    restoreMut.mutate({ backupId: bid })
  }

  const machineName = qMachine.data?.name || '…'
  const configPath = qMachine.data?.framework_config_path || ''

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Config Backups</SheetTitle>
          <p className="pr-8 text-sm text-muted-foreground">
            {machineName}
            {configPath ? (
              <>
                {' '}
                · <span className="font-mono text-xs">{configPath}</span>
              </>
            ) : null}
          </p>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {qBackups.isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading backups…
            </div>
          ) : qBackups.isError ? (
            <p className="text-sm text-destructive">{qBackups.error?.message || 'Failed to load backups'}</p>
          ) : backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No backups yet. Backups are created automatically before each save.
            </p>
          ) : (
            <ul className="space-y-3">
              {backups.map((b) => (
                <li key={b.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 text-sm">
                      <div className="font-medium">{formatBackupTime(b.created_at)}</div>
                      <div className="text-xs text-muted-foreground">{formatBytes(b.size_bytes)}</div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handlePreview(b.id)}
                        disabled={restoreMut.isPending}
                      >
                        Preview
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleRestore(b.id)}
                        disabled={restoreMut.isPending}
                      >
                        {restoreMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Restore
                      </Button>
                    </div>
                  </div>
                  {previewId === b.id ? (
                    <div className="mt-2">
                      {previewError ? (
                        <p className="text-sm text-destructive">{previewError}</p>
                      ) : previewText == null ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                        </div>
                      ) : (
                        <pre className="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-xs">
                          {previewText}
                        </pre>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {restoreMut.isError ? (
          <p className="text-sm text-destructive">{restoreMut.error?.message}</p>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
