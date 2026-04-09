import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import {
  addBifrostProviderKey,
  createBifrostProvider,
  deleteBifrostProvider,
  deleteBifrostProviderKey,
  getBifrostHealth,
  getBifrostMetrics,
  getBifrostProviderHealth,
  listBifrostKeys,
  listBifrostModels,
  listBifrostProviders,
} from '@/api/bifrost.js'
import { labelForBifrostProvider } from '@/constants/bifrostProviderLabels.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Input } from '@/components/ui/input.jsx'

function providerKeyFromModelId(id) {
  const s = String(id || '')
  const i = s.indexOf('/')
  if (i <= 0) return '_other'
  return s.slice(0, i)
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

function truncateKeyId(s) {
  if (s == null || s === '') return '—'
  const t = String(s)
  if (t.length <= 18) return t
  return `${t.slice(0, 10)}…${t.slice(-6)}`
}

function ProviderModelBars({ byModel }) {
  const [showAll, setShowAll] = useState(false)
  const entries = Object.entries(byModel || {})
    .map(([model, v]) => ({ model, n: v?.requests_total ?? 0 }))
    .sort((a, b) => b.n - a.n)
  const shown = showAll ? entries : entries.slice(0, 5)
  const max = Math.max(...shown.map((x) => x.n), 1)

  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No request data for this provider.</p>
  }

  return (
    <div className="space-y-2">
      {shown.map(({ model, n }) => (
        <div key={model} className="flex items-center gap-2 text-xs">
          <span className="w-40 shrink-0 truncate font-mono-ui" title={model}>
            {model}
          </span>
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-muted">
            <div
              className="h-full rounded bg-primary/80"
              style={{ width: `${max ? (n / max) * 100 : 0}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{n} req</span>
        </div>
      ))}
      {entries.length > 5 && (
        <button
          type="button"
          className="text-xs text-primary underline-offset-4 hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}

export function BifrostPage() {
  const qc = useQueryClient()
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [addKeyFor, setAddKeyFor] = useState(null)
  const [keyDraft, setKeyDraft] = useState('')

  const qHealth = useQuery({
    queryKey: ['bifrost-health'],
    queryFn: getBifrostHealth,
    refetchInterval: 30_000,
    retry: false,
  })

  const qMetrics = useQuery({
    queryKey: ['bifrost-metrics'],
    queryFn: getBifrostMetrics,
    refetchInterval: 60_000,
    retry: false,
  })

  const qProviderHealth = useQuery({
    queryKey: ['bifrost-provider-health'],
    queryFn: getBifrostProviderHealth,
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

  const mCreateProvider = useMutation({
    mutationFn: async ({ name, url }) => {
      const n = name.trim()
      const u = url.trim()
      await createBifrostProvider({ name: n, url: u, type: 'openai' })
      try {
        await addBifrostProviderKey(n, 'dummy-key')
      } catch {
        /* Provider was created; key can be added manually if required */
      }
    },
    onSuccess: () => {
      setNewName('')
      setNewUrl('')
      qc.invalidateQueries({ queryKey: ['bifrost-providers'] })
      qc.invalidateQueries({ queryKey: ['bifrost-provider-health'] })
      qc.invalidateQueries({ queryKey: ['bifrost-metrics'] })
      qc.invalidateQueries({ queryKey: ['bifrost-keys'] })
      qc.invalidateQueries({ queryKey: ['bifrost-models'] })
    },
  })

  const mDeleteProvider = useMutation({
    mutationFn: (name) => deleteBifrostProvider(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bifrost-providers'] })
      qc.invalidateQueries({ queryKey: ['bifrost-provider-health'] })
      qc.invalidateQueries({ queryKey: ['bifrost-metrics'] })
      qc.invalidateQueries({ queryKey: ['bifrost-keys'] })
      qc.invalidateQueries({ queryKey: ['bifrost-models'] })
    },
  })

  const mAddKey = useMutation({
    mutationFn: ({ providerName, key }) => addBifrostProviderKey(providerName, key),
    onSuccess: (_, { providerName }) => {
      setAddKeyFor(null)
      setKeyDraft('')
      qc.invalidateQueries({ queryKey: ['bifrost-keys'] })
    },
  })

  const mDeleteKey = useMutation({
    mutationFn: ({ providerName, keyId }) => deleteBifrostProviderKey(providerName, keyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bifrost-keys'] })
    },
  })

  const providers = qProviders.data?.providers ?? []
  const rawKeys = qKeys.data
  const keys = Array.isArray(rawKeys) ? rawKeys : Array.isArray(rawKeys?.keys) ? rawKeys.keys : []
  const modelRows = qModels.data?.data ?? []
  const modelGroups = groupBifrostModels(modelRows)

  const metrics = qMetrics.data
  const metricsUnavailable = metrics?.metrics_unavailable === true
  const totalRequests = metrics?.total_requests
  const totalErrors = metrics?.total_errors
  const byProviderMetrics = metrics?.by_provider ?? {}

  const healthByName = useMemo(() => {
    const map = new Map()
    for (const h of qProviderHealth.data?.providers ?? []) {
      map.set(h.name, h)
    }
    return map
  }, [qProviderHealth.data])

  const errorRatePct =
    totalRequests != null &&
    totalErrors != null &&
    totalRequests > 0 &&
    !metricsUnavailable
      ? ((totalErrors / totalRequests) * 100).toFixed(1)
      : totalRequests === 0 && !metricsUnavailable
        ? '0.0'
        : null

  const refreshAll = () => qc.invalidateQueries()

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bifrost</h1>
          <p className="text-sm text-muted-foreground">
            OpenAI-compatible router — providers, keys, and models.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        </div>
      </header>

      {qHealth.isError && (
        <p className="text-sm text-destructive">
          Health check failed — set BIFROST_URL on the API host.
        </p>
      )}

      {/* Section 1: Summary */}
      <div className="flex flex-wrap gap-2">
        {qHealth.data?.ok ? (
          <Badge className="bg-emerald-600">Bifrost: OK</Badge>
        ) : (
          <Badge variant="destructive">Bifrost: Unreachable</Badge>
        )}
        <Badge variant="secondary" className="font-normal">
          Total requests:{' '}
          {metricsUnavailable || totalRequests == null ? '—' : String(totalRequests)}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          Errors:{' '}
          {metricsUnavailable || totalErrors == null
            ? '—'
            : `${totalErrors}${errorRatePct != null ? ` (${errorRatePct}%)` : ''}`}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          Active providers: {providers.length}
        </Badge>
      </div>

      {metricsUnavailable && (
        <p className="text-sm text-muted-foreground">
          Metrics not available — enable in Bifrost config.
        </p>
      )}

      {/* Section 2: Provider health table */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="text-base">Providers</CardTitle>
            <CardDescription>
              Health checks and usage from Bifrost metrics (when enabled).
            </CardDescription>
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!newName.trim() || !newUrl.trim() || mCreateProvider.isPending) return
              mCreateProvider.mutate({ name: newName, url: newUrl })
            }}
          >
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="bp-name">
                Name
              </label>
              <Input
                id="bp-name"
                className="h-8 w-36"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-provider"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="bp-url">
                URL
              </label>
              <Input
                id="bp-url"
                className="h-8 min-w-[12rem] flex-1 font-mono-ui text-xs"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="http://host:port"
              />
            </div>
            <Button type="submit" size="sm" disabled={mCreateProvider.isPending}>
              {mCreateProvider.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
            </Button>
          </form>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {qProviders.isLoading || qProviderHealth.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Provider</th>
                  <th className="pb-2 pr-2 font-medium">URL</th>
                  <th className="pb-2 pr-2 font-medium">Health</th>
                  <th className="pb-2 pr-2 font-medium">Latency</th>
                  <th className="pb-2 pr-2 font-medium">Requests</th>
                  <th className="pb-2 pr-2 font-medium">Errors</th>
                  <th className="pb-2 pr-2 font-medium">P95</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {providers.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-4 text-muted-foreground">
                      No providers
                    </td>
                  </tr>
                )}
                {providers.map((p, i) => {
                  const name = p.name ?? p.key ?? `provider-${i}`
                  const url = p.base_url ?? p.url ?? ''
                  const h = healthByName.get(name)
                  const pm = byProviderMetrics[name]
                  const ok = h?.ok === true
                  return (
                    <tr key={`${name}-${i}`} className="border-b border-border/60">
                      <td className="py-2 pr-2 align-top font-medium">
                        {labelForBifrostProvider(name)}
                      </td>
                      <td className="py-2 pr-2 align-top font-mono-ui text-xs break-all text-muted-foreground">
                        {url || '—'}
                      </td>
                      <td className="py-2 pr-2 align-top">
                        {h ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className={ok ? 'h-2 w-2 rounded-full bg-emerald-500' : 'h-2 w-2 rounded-full bg-red-500'}
                            />
                            {ok ? 'OK' : 'Unreachable'}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-2 align-top tabular-nums">
                        {h?.latency_ms != null ? `${h.latency_ms} ms` : '—'}
                      </td>
                      <td className="py-2 pr-2 align-top tabular-nums">
                        {metricsUnavailable || pm == null ? '—' : pm.requests_total ?? '—'}
                      </td>
                      <td className="py-2 pr-2 align-top tabular-nums">
                        {metricsUnavailable || pm == null ? '—' : pm.errors_total ?? '—'}
                      </td>
                      <td className="py-2 pr-2 align-top tabular-nums">
                        {metricsUnavailable || pm == null || pm.p95_ms == null
                          ? '—'
                          : `${pm.p95_ms} ms`}
                      </td>
                      <td className="py-2 align-top text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10"
                          disabled={mDeleteProvider.isPending}
                          onClick={() => {
                            if (
                              typeof window !== 'undefined' &&
                              !window.confirm(`Remove provider "${name}"?`)
                            ) {
                              return
                            }
                            mDeleteProvider.mutate(name)
                          }}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {mCreateProvider.isError && (
            <p className="mt-2 text-xs text-destructive">
              {mCreateProvider.error?.message ?? 'Failed to add provider'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Section 3: Request bars by provider */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Requests by model</h2>
        {qMetrics.isError && (
          <p className="text-sm text-muted-foreground">Could not load metrics from the API.</p>
        )}
        {Object.keys(byProviderMetrics).length === 0 && !qMetrics.isError && (
          <p className="text-sm text-muted-foreground">
            {metricsUnavailable
              ? 'No metrics data.'
              : 'No per-provider request breakdown yet.'}
          </p>
        )}
        {Object.keys(byProviderMetrics).length > 0 &&
          !Object.values(byProviderMetrics).some(
            (p) => p?.by_model && Object.keys(p.by_model).length > 0
          ) &&
          !metricsUnavailable &&
          !qMetrics.isError && (
            <p className="text-sm text-muted-foreground">No per-model breakdown in metrics.</p>
          )}
        {Object.entries(byProviderMetrics).map(([pname, pdata]) => {
          if (!pdata?.by_model || Object.keys(pdata.by_model).length === 0) return null
          return (
            <Card key={pname}>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">{labelForBifrostProvider(pname)}</CardTitle>
                <CardDescription className="font-mono-ui text-xs">{pname}</CardDescription>
              </CardHeader>
              <CardContent>
                <ProviderModelBars byModel={pdata.by_model} />
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Section 4: Models */}
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

      {/* Section 5: Keys */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Keys</CardTitle>
          <CardDescription>
            <code className="font-mono-ui text-xs">GET /api/keys</code> via Bifrost — revoke or add
            keys per provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {qKeys.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <>
              {providers.map((p, i) => {
                const pname = p.name ?? p.key ?? `provider-${i}`
                const provKeys = keys.filter((k) => (k.provider ?? k.provider_name) === pname)
                return (
                  <div key={`keys-${pname}`} className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{labelForBifrostProvider(pname)}</span>
                      {addKeyFor === pname ? (
                        <form
                          className="flex flex-wrap items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault()
                            const v = keyDraft.trim()
                            if (!v || mAddKey.isPending) return
                            mAddKey.mutate({ providerName: pname, key: v })
                          }}
                        >
                          <Input
                            className="h-8 max-w-xs font-mono-ui text-xs"
                            type="password"
                            autoComplete="off"
                            placeholder="Key value"
                            value={keyDraft}
                            onChange={(e) => setKeyDraft(e.target.value)}
                          />
                          <Button type="submit" size="sm" disabled={mAddKey.isPending}>
                            Save
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setAddKeyFor(null)
                              setKeyDraft('')
                            }}
                          >
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setAddKeyFor(pname)
                            setKeyDraft('')
                          }}
                        >
                          Add key
                        </Button>
                      )}
                    </div>
                    <ul className="space-y-2">
                      {provKeys.length === 0 && (
                        <li className="text-xs text-muted-foreground">No keys for this provider.</li>
                      )}
                      {provKeys.map((k, ki) => {
                        const kid = k.id ?? k.key_id ?? k.name ?? String(ki)
                        const keyProvider = k.provider ?? k.provider_name ?? pname
                        return (
                          <li
                            key={kid}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-muted/15 px-3 py-2 text-xs"
                          >
                            <div className="min-w-0 space-y-0.5">
                              <div className="font-mono-ui text-[11px]" title={String(kid)}>
                                {truncateKeyId(kid)}
                              </div>
                              <div className="text-muted-foreground">{keyProvider}</div>
                              <div className="text-muted-foreground">
                                {Array.isArray(k.models) && k.models.length > 0
                                  ? k.models.join(', ')
                                  : 'all models (wildcard)'}
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="shrink-0 text-destructive hover:bg-destructive/10"
                              disabled={mDeleteKey.isPending}
                              onClick={() => {
                                if (
                                  typeof window !== 'undefined' &&
                                  !window.confirm('Revoke this key?')
                                ) {
                                  return
                                }
                                mDeleteKey.mutate({ providerName: String(keyProvider), keyId: String(kid) })
                              }}
                            >
                              Revoke
                            </Button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )
              })}
              {keys.filter((k) => {
                const pn = k.provider ?? k.provider_name
                return pn && !providers.some((p) => (p.name ?? p.key) === pn)
              }).length > 0 && (
                <div className="space-y-2">
                  <span className="text-sm font-medium text-muted-foreground">Other keys</span>
                  <ul className="space-y-2">
                    {keys
                      .filter((k) => {
                        const pn = k.provider ?? k.provider_name
                        return pn && !providers.some((p) => (p.name ?? p.key) === pn)
                      })
                      .map((k, ki) => {
                        const kid = k.id ?? k.key_id ?? k.name ?? String(ki)
                        const pn = k.provider ?? k.provider_name
                        return (
                          <li
                            key={`other-${kid}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-muted/15 px-3 py-2 text-xs"
                          >
                            <div className="min-w-0 space-y-0.5">
                              <div className="font-mono-ui text-[11px]">{truncateKeyId(kid)}</div>
                              <div className="text-muted-foreground">{pn}</div>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="shrink-0 text-destructive hover:bg-destructive/10"
                              disabled={mDeleteKey.isPending}
                              onClick={() => {
                                if (
                                  typeof window !== 'undefined' &&
                                  !window.confirm('Revoke this key?')
                                ) {
                                  return
                                }
                                mDeleteKey.mutate({ providerName: String(pn), keyId: String(kid) })
                              }}
                            >
                              Revoke
                            </Button>
                          </li>
                        )
                      })}
                  </ul>
                </div>
              )}
              {keys.some((k) => !k.provider && !k.provider_name) && (
                <div className="space-y-2">
                  <span className="text-sm font-medium text-muted-foreground">Keys without provider</span>
                  <ul className="space-y-2">
                    {keys
                      .filter((k) => !k.provider && !k.provider_name)
                      .map((k, ki) => {
                        const kid = k.id ?? k.key_id ?? k.name ?? String(ki)
                        return (
                          <li
                            key={`orphan-${kid}`}
                            className="rounded-md border border-border/80 bg-muted/15 px-3 py-2 text-xs"
                          >
                            <div className="font-mono-ui text-[11px]" title={String(kid)}>
                              {truncateKeyId(kid)}
                            </div>
                            <div className="text-muted-foreground">No provider association</div>
                          </li>
                        )
                      })}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
