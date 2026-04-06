import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import {
  getBifrostHealth,
  listBifrostKeys,
  listBifrostModels,
  listBifrostProviders,
} from '@/api/bifrost.js'
import { BIFROST_PROVIDER_LABELS } from '@/constants/bifrostProviderLabels.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'

function providerKeyFromModelId(id) {
  const s = String(id || '')
  const i = s.indexOf('/')
  if (i <= 0) return '_other'
  return s.slice(0, i)
}

function labelForBifrostProvider(key) {
  if (key === '_other') return 'Other'
  return BIFROST_PROVIDER_LABELS[key] || key
}

function groupBifrostModels(rows) {
  const map = new Map()
  for (const m of rows) {
    const key = providerKeyFromModelId(m?.id)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(m)
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === '_other') return 1
    if (b === '_other') return -1
    return labelForBifrostProvider(a).localeCompare(labelForBifrostProvider(b))
  })
  return keys.map((k) => ({ providerKey: k, label: labelForBifrostProvider(k), models: map.get(k) }))
}

export function BifrostPage() {
  const qc = useQueryClient()

  const qHealth = useQuery({
    queryKey: ['bifrost-health'],
    queryFn: getBifrostHealth,
    refetchInterval: 30_000,
    retry: false,
  })

  const qProviders = useQuery({
    queryKey: ['bifrost-providers'],
    queryFn: listBifrostProviders,
  })

  const qKeys = useQuery({
    queryKey: ['bifrost-keys'],
    queryFn: listBifrostKeys,
  })

  const qModels = useQuery({
    queryKey: ['bifrost-models'],
    queryFn: listBifrostModels,
    refetchInterval: 60_000,
  })

  const providers = qProviders.data?.providers ?? []
  const keys = Array.isArray(qKeys.data) ? qKeys.data : []
  const modelRows = qModels.data?.data ?? []
  const modelGroups = groupBifrostModels(modelRows)

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bifrost</h1>
          <p className="text-sm text-muted-foreground">OpenAI-compatible router — providers, keys, and models.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {qHealth.data?.ok ? (
            <Badge className="bg-emerald-600">Reachable</Badge>
          ) : (
            <Badge variant="destructive">Unreachable</Badge>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => qc.invalidateQueries()}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        </div>
      </header>

      {qHealth.isError && (
        <p className="text-sm text-destructive">Health check failed — set BIFROST_URL on the API host.</p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Providers</CardTitle>
            <CardDescription>
              <code className="font-mono-ui text-xs">GET /api/providers</code> via Bifrost
            </CardDescription>
          </CardHeader>
          <CardContent>
            {qProviders.isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
                {providers.length === 0 && <li className="text-muted-foreground">No providers</li>}
                {providers.map((p, i) => (
                  <li key={i} className="rounded-md border border-border/80 bg-muted/15 px-3 py-2 text-xs space-y-0.5">
                    <div className="font-medium">{p.name ?? p.key ?? `Provider ${i + 1}`}</div>
                    {p.base_url && (
                      <div className="font-mono-ui text-muted-foreground break-all">{p.base_url}</div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      {p.status != null && (
                        <Badge variant="outline" className="text-[10px] font-normal">{p.status}</Badge>
                      )}
                      {p.concurrency != null && (
                        <span className="text-muted-foreground">concurrency: {p.concurrency}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Keys</CardTitle>
            <CardDescription>
              <code className="font-mono-ui text-xs">GET /api/keys</code> via Bifrost
            </CardDescription>
          </CardHeader>
          <CardContent>
            {qKeys.isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
                {keys.length === 0 && <li className="text-muted-foreground">No keys</li>}
                {keys.map((k, i) => (
                  <li key={i} className="rounded-md border border-border/80 bg-muted/15 px-3 py-2 text-xs space-y-0.5">
                    <div className="font-medium">{k.name ?? k.key_name ?? `Key ${i + 1}`}</div>
                    {k.provider && (
                      <div className="text-muted-foreground">{k.provider}</div>
                    )}
                    <div className="text-muted-foreground">
                      {Array.isArray(k.models) && k.models.length > 0
                        ? k.models.join(', ')
                        : 'all models (wildcard)'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Models</CardTitle>
          <CardDescription>
            <code className="font-mono-ui text-xs">GET /v1/models</code> via Bifrost
          </CardDescription>
        </CardHeader>
        <CardContent>
          {qModels.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <div className="max-h-64 space-y-4 overflow-y-auto text-sm">
              {modelRows.length === 0 && <p className="text-muted-foreground">No models</p>}
              {modelGroups.map((g) => (
                <div key={g.providerKey}>
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px] font-normal">
                      {g.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{g.models.length} model(s)</span>
                  </div>
                  <ul className="space-y-1">
                    {g.models.map((m) => (
                      <li
                        key={m.id}
                        className="rounded-md border border-border/80 bg-muted/15 px-2 py-1 font-mono-ui text-xs break-all"
                      >
                        {m.id}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
