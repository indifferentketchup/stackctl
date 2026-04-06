import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BookOpen,
  Bot,
  Cpu,
  GitBranch,
  Network,
  Server,
  Users,
} from 'lucide-react'
import { getBifrostHealth } from '@/api/bifrost.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'

const cards = [
  {
    to: '/machines',
    title: 'Machines',
    description: 'GPU telemetry over SSH, links to llama-swap editors.',
    icon: Server,
  },
  {
    to: '/bifrost',
    title: 'Bifrost',
    description: 'Router YAML, providers, merged OpenAI model list.',
    icon: Network,
  },
  {
    to: '/llamaswap/sam-desktop',
    title: 'llama-swap (sam-desktop)',
    description: 'Windows host config, running models, unload.',
    icon: Cpu,
  },
  {
    to: '/llamaswap/gpu',
    title: 'llama-swap (gpu)',
    description: 'Linux host config and service controls.',
    icon: Cpu,
  },
  {
    to: '/personas',
    title: 'Personas',
    description: 'Sync personas with boolab.',
    icon: Users,
  },
  {
    to: '/rag',
    title: 'RAG',
    description: 'Documents, chunking, ChromaDB.',
    icon: BookOpen,
    disabled: true,
  },
  {
    to: '/agents',
    title: 'Agents',
    description: 'Tool-using agents and tests.',
    icon: Bot,
  },
  {
    to: '/flows',
    title: 'Flows',
    description: 'Visual flow builder.',
    icon: GitBranch,
  },
]

export function HomePage() {
  const { data: health } = useQuery({
    queryKey: ['bifrost-health'],
    queryFn: getBifrostHealth,
    refetchInterval: 60_000,
    retry: false,
  })

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">stackctl</h1>
          <p className="text-muted-foreground">Homelab AI inference control plane (Bifrost + llama-swap)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {health?.ok ? (
            <Badge variant="secondary">Bifrost OK</Badge>
          ) : (
            <Badge variant="outline">Bifrost unreachable</Badge>
          )}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => {
          const Icon = c.icon
          const inner = (
            <Card
              className={
                c.disabled ? 'opacity-50' : 'transition-colors hover:border-primary/40'
              }
            >
              <CardHeader className="space-y-1">
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5 text-primary" />
                  <CardTitle className="text-lg">{c.title}</CardTitle>
                </div>
                <CardDescription>{c.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" size="sm" className="w-full sm:w-auto" disabled={c.disabled} asChild={!c.disabled}>
                  {c.disabled ? (
                    <span>Phase 6 — soon</span>
                  ) : (
                    <Link to={c.to} className="inline-flex items-center gap-2">
                      Open <ArrowRight className="h-4 w-4" />
                    </Link>
                  )}
                </Button>
              </CardContent>
            </Card>
          )
          return <div key={c.to}>{inner}</div>
        })}
      </div>
    </div>
  )
}
