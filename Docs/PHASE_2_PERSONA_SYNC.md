# OllamaCtl — Phase 2: Persona Sync
Last updated: March 2026

---

## Goal
Full persona management UI that reads and writes directly to boolab's PostgreSQL via the boolab API. Changes made here are immediately reflected in BooOps and 808notes.

---

## Key Principle
OllamaCtl does NOT store personas. It proxies all persona CRUD through `http://100.114.205.53:9300/api/personas/`. The boolab API is the source of truth. OllamaCtl just provides a better UI for managing them.

---

## Backend Routes

### `GET /api/personas`
Proxies `GET http://BOOLAB_API_URL/api/personas/` with the JWT cookie forwarded. Returns full persona list.

### `POST /api/personas`
Proxies `POST http://BOOLAB_API_URL/api/personas/` with body forwarded.

### `PUT /api/personas/{id}`
Proxies `PUT http://BOOLAB_API_URL/api/personas/{id}` with body forwarded.

### `DELETE /api/personas/{id}`
Proxies `DELETE http://BOOLAB_API_URL/api/personas/{id}`.

### `POST /api/personas/{id}/icon`
Proxies `POST http://BOOLAB_API_URL/api/personas/{id}/icon` — multipart upload forwarded.

### `POST /api/personas/{id}/set-default`
Proxies `POST http://BOOLAB_API_URL/api/personas/{id}/set-default?slot={booops|808notes}`.

All proxy routes forward the Authorization header / cookie from the incoming request.

---

## Frontend Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/personas` | `PersonasPage` | Grid of all personas |
| `/personas/create` | `PersonaCreatePage` | New persona form |
| `/personas/:id` | `PersonaEditPage` | Edit existing persona |

---

## PersonasPage
- Card grid (2-3 columns desktop, 1 column mobile)
- Each card:
  - Avatar image or emoji (large, centered)
  - Name
  - System prompt preview (3 lines, truncated)
  - Default badges: `● BooOps default` / `● 808notes default`
  - Actions: Edit | Delete | Set as BooOps default | Set as 808notes default
- "New Persona" button top-right
- "Synced with boolab" status indicator — shows last fetch timestamp
- Search/filter bar
- Sort: name / created / modified

## PersonaCreatePage / PersonaEditPage
Full-page form, split layout on desktop (form left, preview right):

**Left — Form:**
- **Avatar** section:
  - Emoji input (large text field, single emoji)
  - Image upload (drag-drop or click). Shows current image if set.
  - "Remove image" button if image set
  - Helper: "Image overrides emoji. Recommended: square PNG, 256×256 or larger."
- **Name** — text input
- **System Prompt** — large textarea (min 200px height, resizable)
  - Character count
  - "Insert example prompt" dropdown with presets:
    - General assistant
    - Code-focused
    - Academic/research
    - Creative writing
    - Concise responder
- **Default settings:**
  - "Set as BooOps default" toggle
  - "Set as 808notes default" toggle
  - Helper: "Only one persona can be the default per mode. Setting a new default removes the previous one."

**Right — Live Preview:**
- Shows avatar + name + system prompt as it will appear in boolab
- "Test this persona" section:
  - Model picker (fetched from Ollama)
  - Mini chat input
  - Response shows inline — streaming via boolab's Ollama proxy
  - Helper: "Send a message to test how this persona responds before saving."

**Bottom actions:**
- Save button (primary, magenta)
- Cancel button (outline)
- Delete button (destructive, only on edit page, disabled for system personas)

---

## Constraints from Boolab API
- Personas with `owner_id = NULL` are system personas — cannot be deleted
- System personas: BooOps (🤖), 808notes (🎵), Tweak (🐾)
- Show lock icon on system persona cards and disable delete
- Setting default for one mode clears the previous default for that mode (handled server-side)

---

## Sync Indicator
Top of personas page shows:
```
🔗 Synced with boolab API · Last fetched 12s ago · [Refresh]
```
Clicking refresh re-fetches from boolab API. Auto-refreshes every 60s when page is active.

---

## Cursor Context Files for Phase 2
- `CONTEXT.md`
- `DB_SCHEMA.md`
- `UI_DESIGN.md`
- `PHASE_1_MODEL_MANAGEMENT.md` (for existing route/component patterns)

**Also include from boolab repo:**
- `backend/routers/personas.py` (boolab) — understand the API shape
- `frontend/src/pages/booops/AISettings.jsx` (boolab) — existing persona UI to improve upon

---

## Estimated Cursor Sessions
1 session.
