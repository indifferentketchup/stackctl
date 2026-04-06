import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  BookOpen,
  Bot,
  GitBranch,
  Server,
  Network,
  Cpu,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBifrostHealth } from '@/api/bifrost.js'

const linkClass = ({ isActive }) =>
  cn(
    'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
    isActive ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
  )

const Soon = () => <span className="text-xs text-muted-foreground">(soon)</span>

export function Sidebar() {
  const { pathname } = useLocation()
  const [bifrostOk, setBifrostOk] = useState(null)

  useEffect(() => {
    let cancelled = false
    const ping = async () => {
      try {
        const h = await getBifrostHealth()
        if (!cancelled) setBifrostOk(!!h?.ok)
      } catch {
        if (!cancelled) setBifrostOk(false)
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
          stackctl
        </NavLink>
        <p className="text-xs text-muted-foreground">Inference stack control plane</p>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        <NavLink to="/" end className={linkClass}>
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          Dashboard
        </NavLink>
        <div className="space-y-0.5">
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Stack
          </div>
          <NavLink to="/machines" className={linkClass}>
            <Server className="h-4 w-4 shrink-0" />
            Machines
          </NavLink>
          <NavLink to="/bifrost" className={linkClass}>
            <Network className="h-4 w-4 shrink-0" />
            Bifrost
          </NavLink>
          <NavLink to="/llamaswap/sam-desktop" className={linkClass}>
            <Cpu className="h-4 w-4 shrink-0" />
            llama-swap · sam-desktop
          </NavLink>
          <NavLink to="/llamaswap/gpu" className={linkClass}>
            <Cpu className="h-4 w-4 shrink-0" />
            llama-swap · gpu
          </NavLink>
        </div>

        <div className="my-2 border-t border-border" />

        <NavLink to="/personas" className={linkClass}>
          <Users className="h-4 w-4 shrink-0" />
          Personas
        </NavLink>
        <span
          className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground opacity-50"
          title="Phase 6"
        >
          <BookOpen className="h-4 w-4 shrink-0" />
          RAG <Soon />
        </span>
        <NavLink to="/agents" className={linkClass}>
          <Bot className="h-4 w-4 shrink-0" />
          Agents
        </NavLink>
        <NavLink to="/flows" className={linkClass}>
          <GitBranch className="h-4 w-4 shrink-0" />
          Flows{' '}
          <span className="text-[10px] text-muted-foreground font-normal">(beta)</span>
        </NavLink>
      </nav>
      <div className="mt-auto border-t border-border p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              bifrostOk === true ? 'bg-emerald-500' : bifrostOk === false ? 'bg-red-500' : 'bg-muted-foreground'
            )}
          />
          <span>
            Bifrost {bifrostOk === true ? 'reachable' : bifrostOk === false ? 'unreachable' : '…'}
          </span>
        </div>
      </div>
    </aside>
  )
}
