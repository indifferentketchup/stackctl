import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, Save } from 'lucide-react'
import {
  getBifrostConfig,
  getBifrostHealth,
  listBifrostModels,
  listBifrostProviders,
  putBifrostConfig,
} from '@/api/bifrost.js'
import { BIFROST_PROVIDER_LABELS } from '@/constants/bifrostProviderLabels.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'

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
  const [draft, setDraft] = useState('')

  const qHealth = useQuery({
    queryKey: ['bifrost-health'],
    queryFn: getBifrostHealth,
    refetchInterval: 30_000,
    retry: false,
  })

  const qConfig = useQuery({
    queryKey: ['bifrost-config'],
    queryFn: getBifrostConfig,
  })

  const qProviders = useQuery({
    queryKey: ['bifrost-providers'],
    queryFn: listBifrostProviders,
  })

  const qModels = useQuery({
    queryKey: ['bifrost-models'],
    queryFn: listBifrostModels,
    refetchInterval: 60_000,
  })

  useEffect(() => {
    if (qConfig.data?.yaml_text != null) setDraft(qConfig.data.yaml_text)
  }, [qConfig.data?.yaml_text])

  const saveMut = useMutation({
    mutationFn: () => putBifrostConfig(draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bifrost-config'] })
      qc.invalidateQueries({ queryKey: ['bifrost-models'] })
    },
  })

  const providers = qProviders.data?.providers ?? []
  const modelRows = qModels.data?.data ?? []
  const modelGroups = groupBifrostModels(modelRows)

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bifrost</h1>
          <p className="text-sm text-muted-foreground">OpenAI-compatible router config and merged model list.</p>
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
            <CardDescription>From <code className="font-mono-ui text-xs">providers</code> in config YAML.</CardDescription>
          </CardHeader>
          <CardContent>
            {qProviders.isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <ul className="max-h-48 list-inside list-disc space-y-1 overflow-y-auto text-sm">
                {providers.length === 0 && <li className="text-muted-foreground">No providers parsed</li>}
                {providers.map((p, i) => (
                  <li key={i} className="font-mono-ui text-xs break-all">
                    {typeof p === 'string' ? p : JSON.stringify(p)}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Config file</CardTitle>
          <CardDescription>Path is configured on the server (BIFROST_CONFIG_PATH). Save validates YAML and restarts Docker Compose.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {qConfig.data?.path && (
            <p className="font-mono-ui text-xs text-muted-foreground break-all">{qConfig.data.path}</p>
          )}
          <Textarea
            className="min-h-[320px] font-mono-ui text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
              {saveMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save &amp; restart Bifrost
            </Button>
            {saveMut.isError && (
              <span className="text-sm text-destructive">{saveMut.error?.message || 'Save failed'}</span>
            )}
            {saveMut.isSuccess && <span className="text-sm text-emerald-600">Saved.</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
