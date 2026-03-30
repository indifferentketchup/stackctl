import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import {
  createPersona,
  deletePersona,
  fetchPersonaIconObjectUrl,
  listPersonas,
  setPersonaDefault,
  updatePersona,
  uploadPersonaIcon,
} from '@/api/personas.js'
import { Badge } from '@/components/ui/badge.jsx'
import { Button } from '@/components/ui/button.jsx'
import { Card } from '@/components/ui/card.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { Textarea } from '@/components/ui/textarea.jsx'
import { cn } from '@/lib/utils.js'

const EXAMPLE_SYSTEM_PROMPT = `You are a helpful assistant embedded in the user's music production workflow. Give concise, practical answers. When discussing audio, MIDI, plugins, or DAW operations, prefer clear steps and safe defaults. If you are unsure, say so instead of guessing.`

function emojiPreview(raw) {
  const s = (raw || '').trim().slice(0, 2)
  return s || '…'
}

function PersonaAvatar({ persona, sizeClass = 'h-14 w-14' }) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    let current = null
    let cancelled = false
    const run = async () => {
      if (!persona?.icon_url || !persona?.id) {
        setUrl(null)
        return
      }
      try {
        const objectUrl = await fetchPersonaIconObjectUrl(persona.id)
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        current = objectUrl
        setUrl(objectUrl)
      } catch {
        if (!cancelled) setUrl(null)
      }
    }
    run()
    return () => {
      cancelled = true
      if (current) URL.revokeObjectURL(current)
    }
  }, [persona?.id, persona?.icon_url])

  if (url) {
    return (
      <img
        src={url}
        alt=""
        className={cn('rounded-full object-cover ring-2 ring-primary/30', sizeClass)}
      />
    )
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-full bg-primary/20 text-2xl ring-2 ring-primary/20',
        sizeClass
      )}
      aria-hidden
    >
      {emojiPreview(persona?.avatar_emoji)}
    </div>
  )
}

export function PersonasPage() {
  const qc = useQueryClient()
  const cardRefs = useRef({})
  const fileInputRef = useRef(null)

  const [formMode, setFormMode] = useState(null) // null | 'create' | 'edit'
  const [editingId, setEditingId] = useState(null)
  const [name, setName] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [avatarEmoji, setAvatarEmoji] = useState('🤖')
  const [saveError, setSaveError] = useState('')

  const personasQuery = useQuery({
    queryKey: ['personas'],
    queryFn: async () => {
      const data = await listPersonas()
      return Array.isArray(data?.items) ? data.items : []
    },
    refetchInterval: 60_000,
  })

  const items = personasQuery.data ?? []

  const booopsDefault = useMemo(() => items.find((p) => p.is_default_booops) ?? null, [items])
  const notesDefault = useMemo(() => items.find((p) => p.is_default_808notes) ?? null, [items])

  const scrollToPersona = (id) => {
    const el = cardRefs.current[id]
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  const resetForm = () => {
    setFormMode(null)
    setEditingId(null)
    setName('')
    setSystemPrompt('')
    setAvatarEmoji('🤖')
    setSaveError('')
  }

  const openCreate = () => {
    setFormMode('create')
    setEditingId(null)
    setName('')
    setSystemPrompt('')
    setAvatarEmoji('🤖')
    setSaveError('')
  }

  const openEdit = (p) => {
    setFormMode('edit')
    setEditingId(p.id)
    setName(p.name ?? '')
    setSystemPrompt(p.system_prompt ?? '')
    setAvatarEmoji((p.avatar_emoji || '🤖').toString().slice(0, 2))
    setSaveError('')
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const emoji = avatarEmoji.trim().slice(0, 2) || '🤖'
      if (formMode === 'create') {
        return createPersona({
          name: name.trim(),
          system_prompt: systemPrompt,
          avatar_emoji: emoji,
        })
      }
      if (formMode === 'edit' && editingId) {
        return updatePersona(editingId, {
          name: name.trim(),
          system_prompt: systemPrompt,
          avatar_emoji: emoji,
        })
      }
      throw new Error('Nothing to save')
    },
    onSuccess: (persona) => {
      qc.invalidateQueries({ queryKey: ['personas'] })
      if (formMode === 'create' && persona?.id) {
        setFormMode('edit')
        setEditingId(persona.id)
      }
      setSaveError('')
    },
    onError: (e) => {
      setSaveError(e?.message || 'Save failed')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => deletePersona(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['personas'] })
      if (editingId === id) resetForm()
    },
  })

  const setDefaultMut = useMutation({
    mutationFn: ({ id, slot }) => setPersonaDefault(id, slot),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personas'] }),
  })

  const removeIconMut = useMutation({
    mutationFn: (id) => updatePersona(id, { icon_url: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personas'] }),
  })

  const uploadIconMut = useMutation({
    mutationFn: ({ id, file }) => uploadPersonaIcon(id, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personas'] }),
  })

  const syncFailed = personasQuery.isFetched && personasQuery.isError
  const syncOk = personasQuery.isFetched && !personasQuery.isError
  const lastSyncLabel = personasQuery.dataUpdatedAt
    ? new Date(personasQuery.dataUpdatedAt).toLocaleString()
    : '—'

  const editingPersona = editingId ? items.find((p) => p.id === editingId) : null
  const canUploadIcon = Boolean(formMode === 'edit' && editingId)
  const isDefaultLocked = (p) => Boolean(p.is_default_booops || p.is_default_808notes)

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Personas</h1>
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title={lastSyncLabel}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  syncOk ? 'bg-emerald-500' : syncFailed ? 'bg-amber-500' : 'bg-muted-foreground'
                )}
              />
              {syncFailed ? (
                <span>Sync failed — boolab API unreachable</span>
              ) : (
                <span>Synced with boolab</span>
              )}
              <span className="text-muted-foreground/80">· {lastSyncLabel}</span>
            </div>
          </div>
        </div>
        <Button type="button" className="gap-2 self-start sm:self-auto" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New Persona
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <button
          type="button"
          onClick={() => booopsDefault && scrollToPersona(booopsDefault.id)}
          className="text-left"
        >
          <Card className="p-4 transition-colors hover:bg-accent/20">
            <div className="text-xs font-medium uppercase text-muted-foreground">BooOps default</div>
            <div className="mt-2 flex items-center gap-3">
              {booopsDefault ? (
                <>
                  <PersonaAvatar persona={booopsDefault} sizeClass="h-10 w-10" />
                  <span className="font-semibold">{booopsDefault.name}</span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Not set</span>
              )}
            </div>
          </Card>
        </button>
        <button
          type="button"
          onClick={() => notesDefault && scrollToPersona(notesDefault.id)}
          className="text-left"
        >
          <Card className="p-4 transition-colors hover:bg-accent/20">
            <div className="text-xs font-medium uppercase text-muted-foreground">
              808notes default
            </div>
            <div className="mt-2 flex items-center gap-3">
              {notesDefault ? (
                <>
                  <PersonaAvatar persona={notesDefault} sizeClass="h-10 w-10" />
                  <span className="font-semibold">{notesDefault.name}</span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Not set</span>
              )}
            </div>
          </Card>
        </button>
      </div>

      {formMode && (
        <Card className="space-y-4 p-4 md:p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {formMode === 'create' ? 'New persona' : 'Edit persona'}
            </h2>
          </div>

          {saveError ? (
            <p className="text-sm text-destructive">{saveError}</p>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="persona-emoji">Emoji (max 2 characters)</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="persona-emoji"
                  value={avatarEmoji}
                  maxLength={2}
                  onChange={(e) => setAvatarEmoji(e.target.value)}
                  className="max-w-[8rem]"
                />
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 text-xl ring-2 ring-primary/20">
                  {emojiPreview(avatarEmoji)}
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Avatar image</Label>
              {!canUploadIcon ? (
                <p className="text-sm text-muted-foreground">Save first, then upload an image.</p>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                    disabled={uploadIconMut.isPending}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (!f || !editingId) return
                      uploadIconMut.mutate({ id: editingId, file: f })
                    }}
                  />
                  {editingPersona?.icon_url ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={removeIconMut.isPending}
                      onClick={() => editingId && removeIconMut.mutate(editingId)}
                    >
                      Remove image
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="persona-name">Name</Label>
            <Input
              id="persona-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="persona-prompt">System prompt</Label>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{systemPrompt.length} characters</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setSystemPrompt(EXAMPLE_SYSTEM_PROMPT)}
                >
                  Insert example
                </Button>
              </div>
            </div>
            <Textarea
              id="persona-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={10}
              className="min-h-[12rem] resize-y font-mono text-sm"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !name.trim()}
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save'
              )}
            </Button>
            <Button type="button" variant="outline" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {personasQuery.isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading personas…
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {items.map((p) => (
          <div
            key={p.id}
            ref={(el) => {
              if (el) cardRefs.current[p.id] = el
            }}
          >
            <Card className="flex flex-col gap-3 p-4">
            <div className="flex gap-3">
              <PersonaAvatar persona={p} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate font-bold">{p.name}</h3>
                  {p.is_default_booops ? (
                    <Badge variant="secondary" className="bg-accent/40 text-accent-foreground">
                      Default (BooOps)
                    </Badge>
                  ) : null}
                  {p.is_default_808notes ? (
                    <Badge variant="secondary" className="bg-accent/40 text-accent-foreground">
                      Default (808notes)
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                  {p.system_prompt || '—'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" size="sm" onClick={() => openEdit(p)}>
                Edit
              </Button>
              {!p.is_default_booops ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={setDefaultMut.isPending}
                  onClick={() => setDefaultMut.mutate({ id: p.id, slot: 'booops' })}
                >
                  Set BooOps default
                </Button>
              ) : null}
              {!p.is_default_808notes ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={setDefaultMut.isPending}
                  onClick={() => setDefaultMut.mutate({ id: p.id, slot: '808notes' })}
                >
                  Set 808notes default
                </Button>
              ) : null}
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="gap-1"
                disabled={isDefaultLocked(p) || deleteMutation.isPending}
                title={isDefaultLocked(p) ? 'Cannot delete a default persona.' : undefined}
                onClick={() => {
                  if (isDefaultLocked(p)) return
                  if (!window.confirm(`Delete persona “${p.name}”? This cannot be undone.`)) return
                  deleteMutation.mutate(p.id)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
            </Card>
          </div>
        ))}
      </div>

      {!personasQuery.isLoading && items.length === 0 && !personasQuery.isError ? (
        <p className="text-sm text-muted-foreground">No personas yet. Create one to get started.</p>
      ) : null}
    </div>
  )
}
