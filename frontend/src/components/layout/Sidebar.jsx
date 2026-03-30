import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { LayoutDashboard, Cpu, Layers, PlusCircle, Users, Monitor, BookOpen, Bot, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { listModels } from '@/api/ollama.js'

const linkClass = ({ isActive }) =>
  cn(
    'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
    isActive ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
  )

const Soon = () => <span className="text-xs text-muted-foreground">(soon)</span>

export function Sidebar() {
  const { pathname } = useLocation()
  const [ollamaOk, setOllamaOk] = useState(null)

  useEffect(() => {
    let cancelled = false
    const ping = async () => {
      try {
        await listModels()
        if (!cancelled) setOllamaOk(true)
      } catch {
        if (!cancelled) setOllamaOk(false)
      }
    }
    ping()
    const t = setInterval(ping, 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [pathname])

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-border bg-card/50 md:h-screen md:w-56 md:border-b-0 md:border-r">
      <div className="border-b border-border px-4 py-4">
        <NavLink to="/" className="text-xl font-bold tracking-tight text-primary">
          ollamactl
        </NavLink>
        <p className="text-xs text-muted-foreground">Ollama control plane</p>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        <NavLink to="/" end className={linkClass}>
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          Dashboard
        </NavLink>
        <NavLink to="/models" className={linkClass}>
          <Layers className="h-4 w-4 shrink-0" />
          Models
        </NavLink>
        <NavLink to="/running" className={linkClass}>
          <Cpu className="h-4 w-4 shrink-0" />
          Running
        </NavLink>
        <NavLink to="/models/create" className={linkClass}>
          <PlusCircle className="h-4 w-4 shrink-0" />
          Create Model
        </NavLink>

        <div className="my-2 border-t border-border" />

        <span
          className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground opacity-50"
          title="Phase 3"
        >
          <Users className="h-4 w-4 shrink-0" />
          Personas <Soon />
        </span>
        <span
          className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground opacity-50"
          title="Phase 5"
        >
          <Monitor className="h-4 w-4 shrink-0" />
          Multi-GPU <Soon />
        </span>
        <span
          className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground opacity-50"
          title="Phase 6"
        >
          <BookOpen className="h-4 w-4 shrink-0" />
          RAG <Soon />
        </span>
        <span
          className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground opacity-50"
          title="Phase 7"
        >
          <Bot className="h-4 w-4 shrink-0" />
          Agents <Soon />
        </span>
        <span
          className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground opacity-50"
          title="Phase 8"
        >
          <GitBranch className="h-4 w-4 shrink-0" />
          Flows <Soon />
        </span>
      </nav>
      <div className="mt-auto border-t border-border p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              ollamaOk === true ? 'bg-emerald-500' : ollamaOk === false ? 'bg-red-500' : 'bg-muted-foreground'
            )}
          />
          <span>Ollama {ollamaOk === true ? 'reachable' : ollamaOk === false ? 'unreachable' : '…'}</span>
        </div>
      </div>
    </aside>
  )
}
