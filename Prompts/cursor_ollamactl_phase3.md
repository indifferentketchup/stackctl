# Cursor Prompt — ollamactl Phase 3: Persona Sync

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `src/App.jsx`
- `src/api/` — all existing API wrappers
- `backend/routers/ollama.py`
- `backend/main.py`

Do not touch any file not explicitly listed in the changes below.

---

## Context
Personas live in boolab's PostgreSQL database. ollamactl reads and writes them directly via boolab's REST API at `BOOLAB_API_URL` (env var, default `http://100.114.205.53:9300`). All persona API calls use the boolab owner JWT stored in `localStorage` under key `ollamactl_boolab_token`.

The boolab persona API is already fully built. ollamactl only needs a frontend page + thin backend proxy.

---

## Backend (`backend/routers/personas.py`) — NEW FILE

Create a new FastAPI router that proxies persona operations to boolab's API.

### Endpoints

**`GET /api/personas`**
- Proxies `GET {BOOLAB_API_URL}/api/personas/`
- Passes `Authorization: Bearer {BOOLAB_OWNER_TOKEN}` header
- Returns response as-is

**`POST /api/personas`**
- Body: `{ name, system_prompt, avatar_emoji }`
- Proxies `POST {BOOLAB_API_URL}/api/personas/`
- Returns created persona

**`PUT /api/personas/{persona_id}`**
- Body: any subset of `{ name, system_prompt, avatar_emoji, is_default_booops, is_default_808notes, icon_url }`
- Proxies `PUT {BOOLAB_API_URL}/api/personas/{persona_id}`
- Returns updated persona

**`DELETE /api/personas/{persona_id}`**
- Proxies `DELETE {BOOLAB_API_URL}/api/personas/{persona_id}`
- Returns `{ ok: true }`

**`POST /api/personas/{persona_id}/icon`**
- Accepts multipart file upload
- Proxies `POST {BOOLAB_API_URL}/api/personas/{persona_id}/icon`
- Returns updated persona

**`POST /api/personas/{persona_id}/set-default`**
- Query param: `slot` (booops or 808notes)
- Proxies `POST {BOOLAB_API_URL}/api/personas/{persona_id}/set-default?slot={slot}`
- Returns updated persona

All endpoints require `require_admin` dependency.
Register router in `backend/main.py` with prefix `/api/personas`.

---

## Frontend

### `src/api/personas.js` — NEW FILE

API wrappers for all persona endpoints. Follow same pattern as `src/api/ollama.js`. Use fetch with `Authorization: Bearer {token}` header from `getOllamactlToken()` helper.

### `src/pages/PersonasPage.jsx` — NEW FILE

**Layout:** Full page. Header "Personas" + "New Persona" button top right.

**Persona list:** Cards in a responsive grid (2 cols desktop, 1 col mobile).

Each card shows:
- Avatar: image if `icon_url` set, else emoji in a colored circle
- Name (bold)
- System prompt preview (3 lines, truncated)
- Default badges: "Default (BooOps)" and/or "Default (808notes)" in accent color
- Action buttons: Edit | Set BooOps Default | Set 808notes Default | Delete

Default buttons only show if that slot is not already set to this persona.
Delete disabled on personas where `is_default_booops` or `is_default_808notes` is true — show tooltip "Cannot delete a default persona."

**Create/Edit form** (inline expand or slide-in panel, not a modal):

Fields:
- Emoji picker: text input with preview, max 2 chars
- Avatar image: file upload (image/*), shows preview, "Remove" button if set
  - Note: on new persona, shows "Save first, then upload an image"
- Name: text input
- System prompt: large textarea (min 8 rows, resizable)
  - Character count
  - "Insert example" button → fills with a useful default system prompt
- Save / Cancel buttons

**Sync status indicator** in page header:
- Green dot + "Synced with boolab" when last fetch succeeded
- Amber dot + "Sync failed — boolab API unreachable" on error
- Timestamp of last sync

**Default persona section** at top of page (above the grid):
- Two small cards side by side: "BooOps Default" and "808notes Default"
- Each shows the current default persona's avatar + name
- Click → jumps to that persona's card

---

## Add to sidebar navigation
Enable the Personas nav item (was disabled/stubbed in Phase 1):
```
Personas → /personas
```

---

## Constraints
- Never call boolab API directly from frontend — always go through `/api/personas` on ollamactl backend
- `BOOLAB_API_URL` and `BOOLAB_OWNER_TOKEN` are env vars on the backend — never expose them to the frontend
- Icon uploads: stream the file through ollamactl backend to boolab (do not store locally)
- Mobile: card grid collapses to single column, form is full-width
- Do not touch any existing files except `src/App.jsx` (add route) and `backend/main.py` (register router)
