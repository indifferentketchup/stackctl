import { useEffect, useRef } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button.jsx'
import { cn } from '@/lib/utils.js'

function toneForLine(text) {
  const t = (text || '').toLowerCase()
  if (
    t.includes(' error') ||
    t.startsWith('error') ||
    t.includes('failed') ||
    (t.includes('exited with code') && !/\bcode\s*0\b/.test(t))
  )
    return 'err'
  if (t.includes('success') || t.includes('completed') || t.includes('done') || t.includes('[cleanup]'))
    return 'ok'
  return 'normal'
}

export function ApplyTerminalPanel({ open, onClose, lines, running, result, pullProgress }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [open, lines, running, pullProgress])

  if (!open) return null

  return (
    <>
      <button
        type="button"
        aria-label="Dismiss overlay"
        className="fixed inset-0 z-[60] bg-black/50 sm:bg-black/30"
        onClick={onClose}
      />
      <div
        className={cn(
          'fixed z-[70] flex flex-col border-border bg-[#0a0a0a] font-mono text-sm shadow-2xl',
          'max-sm:inset-0 max-sm:h-full max-sm:w-full',
          'sm:inset-x-0 sm:bottom-0 sm:h-[min(48vh,480px)] sm:w-full sm:rounded-t-lg sm:border-t',
        )}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2 text-white">
          <div className="flex items-center gap-2">
            {running && <Loader2 className="h-4 w-4 animate-spin text-white/80" />}
            <span className="text-xs font-semibold uppercase tracking-wide text-white/70">
              Remote apply
            </span>
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-8 text-white hover:bg-white/10" onClick={onClose}>
            <X className="h-4 w-4" />
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px] leading-snug">
          {lines.map((line, i) => {
            const tone = toneForLine(line)
            return (
              <div
                key={`${i}-${line.slice(0, 24)}`}
                className={cn(
                  'whitespace-pre-wrap break-all',
                  tone === 'err' && 'text-red-400',
                  tone === 'ok' && 'text-green-400',
                  tone === 'normal' && 'text-white/90',
                )}
              >
                {line}
              </div>
            )
          })}
          {pullProgress && (
            <div className="mt-2 space-y-1">
              <div className="flex justify-between text-xs text-white/50">
                <span>{pullProgress.status}</span>
                <span>{pullProgress.pct}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-white/10">
                <div
                  className="h-1.5 rounded-full bg-purple-500 transition-all duration-200"
                  style={{ width: `${pullProgress.pct}%` }}
                />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="shrink-0 border-t border-white/10 px-3 py-2 text-xs">
          {result === 'success' && <span className="text-green-400">Done ✓</span>}
          {result === 'failed' && <span className="text-red-400">Failed ✗</span>}
          {running && !result && <span className="text-white/60">Running…</span>}
        </div>
      </div>
    </>
  )
}
