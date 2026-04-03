import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BookOpen,
  Bot,
  Cpu,
  GitBranch,
  Layers,
  Monitor,
  PlusCircle,
  Server,
  Upload,
  Users,
} from 'lucide-react'
import { getVersion, listModels } from '@/api/ollama.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'

const cards = [
  {
    to: '/models',
    title: 'Models',
    description: 'List, pull, copy, and delete local models.',
    icon: Layers,
    phase: 'Phase 1',
  },
  {
    to: '/running',
    title: 'Running Models',
    description: 'VRAM usage, keep-alive timers, per-model unload.',
    icon: Cpu,
    phase: 'Phase 1',
  },
  {
    to: '/machines',
    title: 'Machines',
    description: 'Multi-host routing, assignments, live status.',
    icon: Server,
    phase: 'Phase 1',
  },
  {
    to: '/models/create',
    title: 'Create Model',
    description: 'Guided or raw Modelfile builder.',
    icon: PlusCircle,
    phase: 'Phase 2',
  },
  {
    to: '/import',
    title: 'Import Model',
    description: 'GGUF, Safetensors, and HuggingFace import.',
    icon: Upload,
    phase: 'Phase 4',
  },
  {
    to: '/personas',
    title: 'Personas',
    description: 'Sync personas with boolab.',
    icon: Users,
    phase: 'Phase 3',
  },
  {
    to: '/gpu',
    title: 'Multi-GPU',
    description: 'NSSM env and GPU tuning.',
    icon: Monitor,
    phase: 'Phase 5',
  },
  {
    to: '/rag',
    title: 'RAG',
    description: 'Documents, chunking, ChromaDB.',
    icon: BookOpen,
    phase: 'Phase 6',
    disabled: true,
  },
  {
    to: '/agents',
    title: 'Agents',
    description: 'Tool-using agents and tests.',
    icon: Bot,
    phase: 'Phase 7',
  },
  {
    to: '/flows',
    title: 'Flows',
    description: 'Visual flow builder.',
    icon: GitBranch,
    phase: 'Phase 8',
  },
]

export function HomePage() {
  const { data: version } = useQuery({
    queryKey: ['ollama-version'],
    queryFn: getVersion,
    retry: false,
  })

  useQuery({
    queryKey: ['ollama-models-ping'],
    queryFn: listModels,
    refetchInterval: 60_000,
  })

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">ollamactl</h1>
          <p className="text-muted-foreground">Self-hosted Ollama control plane</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {version?.running != null && version.running !== '' ? (
            <Badge variant="secondary">Ollama {version.running}</Badge>
          ) : (
            <Badge variant="outline">Ollama version unavailable</Badge>
          )}
          {version?.update_available && version?.latest && (
            <a
              href="https://github.com/ollama/ollama/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              <Badge variant="amber">Update available → {version.latest}</Badge>
            </a>
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
                    <span>{c.phase} — soon</span>
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
