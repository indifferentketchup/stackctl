# Cursor Prompt — ollamactl Phase 1+2: Model Management + Modelfile Editor

## Context
You are building a new standalone React/Vite app called **ollamactl** from scratch. This is a self-hosted Ollama control plane. It is a separate project from boolab but shares the same design system (Tailwind, shadcn/ui, dark theme). Read the README.md in this project before writing any code.

---

## Mandatory pre-work
Before writing any code:
1. Read `README.md` in full
2. Read `package.json` to understand installed dependencies
3. Read `src/App.jsx` for the current routing structure
4. Read `src/api/ollama.js` for existing API wrappers

Do not touch any file not listed in the changes below.

---

## Stack
- React 18 + Vite + Tailwind + shadcn/ui
- React Router v6 for routing
- TanStack Query for server state
- Lucide React for icons
- Axios or fetch for API calls
- All API calls proxied through FastAPI backend at `/api/`

---

## Backend (`backend/routers/ollama.py`)

Add the following endpoints. The backend proxies all calls to `OLLAMA_URL` env var (default `http://100.101.41.16:11434`).

### Existing endpoints (already implemented, do not change):
- `GET /api/ollama/models` — list models (`/api/tags`)
- `DELETE /api/ollama/models/{name}` — delete model
- `POST /api/ollama/pull` — pull model (SSE streaming)
- `POST /api/ollama/unload-all` — unload all from VRAM

### New endpoints to add:

**`GET /api/ollama/running`**
- Proxies `GET /api/ps` from Ollama
- Returns running models with name, size_vram, expires_at, size

**`POST /api/ollama/unload/{model_name:path}`**
- Unloads a specific model by sending `POST /api/generate` with `keep_alive: 0`

**`GET /api/ollama/show`**
- Query param: `name` (model name)
- Proxies `POST /api/show` with `{"name": name}` to Ollama
- Returns modelfile, template, parameters, details

**`POST /api/ollama/create`**
- Body: `{ name: str, modelfile: str }`
- Proxies `POST /api/create` to Ollama with SSE streaming
- Returns SSE stream of progress events

**`POST /api/ollama/copy`**
- Body: `{ source: str, destination: str }`
- Proxies `POST /api/copy` to Ollama

**`GET /api/ollama/version`**
- Proxies `GET /api/version` from Ollama
- Also fetches latest Ollama release from `https://api.github.com/repos/ollama/ollama/releases/latest`
- Returns `{ running: "0.6.8", latest: "0.6.9", update_available: true }`

All new endpoints require `require_admin` dependency (same as existing endpoints).

---

## Frontend Pages

### Route structure (add to existing React Router config):
```
/models          → ModelsPage
/models/create   → ModelfilePage (create mode)
/models/:name    → ModelfilePage (edit mode, loads existing modelfile)
/running         → RunningModelsPage
```

---

### `src/pages/ModelsPage.jsx`

**Layout:** Full-page table. Header with title "Local Models" + two action buttons: "Pull Model" (opens pull drawer) + "Create Model" (navigates to `/models/create`).

**Table columns:** Name | Size | Param Size | Quantization | Modified | Actions

**Actions per row:**
- Info button → opens model detail sheet (shows modelfile, template, parameters from `/api/ollama/show`)
- Edit button → navigates to `/models/:name`
- Copy button → inline rename input + confirm
- Delete button → confirm dialog, then delete

**Sort:** by Name (default), Size, Modified — buttons in header

**Pull drawer** (slides up from bottom or side):
- Text input: model name (e.g. `llama3.2:latest` or `hf.co/user/repo:Q4_K_M`)
- HuggingFace prefix helper: toggle between Ollama registry and HF — prefixes `hf.co/` automatically
- Pull button → SSE progress: status text + progress bar (completed/total bytes)
- Warning banner if model name contains no tag: "Tip: specify a quant tag e.g. :Q4_K_M"
- Cancel button aborts the stream

**Unload All button** in page header → confirm → calls `/api/ollama/unload-all`

**Version badge** in page header showing current Ollama version. If update available, shows amber "Update Available" badge linking to GitHub releases.

---

### `src/pages/RunningModelsPage.jsx`

**Layout:** Card grid. Auto-refreshes every 10 seconds.

Each card shows:
- Model name
- VRAM usage (size_vram formatted as GB/MB)
- Expires at (countdown timer — time remaining until Ollama unloads it)
- "Unload" button → calls `/api/ollama/unload/{name}` → refetches

Empty state: "No models currently loaded in VRAM."

---

### `src/pages/ModelfilePage.jsx`

This is the core feature. Two modes: create (no model name) and edit (model name in URL param, loads existing modelfile).

**Header:** "Create Model" or "Edit Model: {name}" + back button

**Two-tab toggle:** "Guided" | "Raw"

---

#### Guided Mode

Form sections, each collapsible:

**1. Base Model (FROM)**
- Dropdown of all local models (fetched from `/api/ollama/models`)
- OR text input for custom path/HF ref
- Helper text: "Use an existing local model, a GGUF file path, or a HuggingFace reference like `hf.co/user/repo:Q4_K_M`"

**2. System Prompt (SYSTEM)**
- Large textarea
- Char count
- Helper: "Sets the default behavior/personality. Can be overridden per-chat."
- Example button → fills with a sample system prompt

**3. Chat Template (TEMPLATE)**
- Dropdown: Auto-detect | ChatML | Llama 3 | Mistral | Raw/Custom
- Selecting a preset fills the textarea with the correct template
- "Raw/Custom" shows editable textarea
- Helper: "Must match the model's expected format. Wrong template = garbage output."
- Each preset shows a brief description

**4. Parameters**

Each parameter has: label, input (slider or text), current value display, description, and default value note.

| Parameter | Input type | Range | Description shown in UI |
|---|---|---|---|
| temperature | slider | 0–2, step 0.05 | Higher = more creative, lower = more focused. Recommended: 0.6–0.8 |
| top_k | slider | 1–200, step 1 | Limits token pool size. Lower = more predictable. Default: 40 |
| top_p | slider | 0–1, step 0.05 | Nucleus sampling. Works with top_k. Default: 0.9 |
| min_p | slider | 0–0.2, step 0.01 | Minimum token probability relative to top token. Default: 0.0 |
| num_ctx | select | 2048/4096/8192/16384/32768/65536/131072 | Context window size in tokens. Larger = more memory. |
| num_predict | number input | -1 to 8192 | Max tokens to generate. -1 = unlimited. |
| repeat_penalty | slider | 0.5–2, step 0.05 | Penalizes repeated tokens. 1.0 = no penalty. |
| repeat_last_n | number input | -1 to 512 | How far back to check for repeats. -1 = full context. |
| seed | number input | 0–99999 | Fixed seed for reproducible outputs. 0 = random. |

**5. Stop Tokens**
- List of stop strings
- Add/remove buttons
- Pre-filled suggestions based on selected template preset: ChatML → `<|im_start|>`, `<|im_end|>`, `<|endoftext|>`
- Helper: "Model stops generating when it hits any of these strings."

**6. LoRA Adapter (ADAPTER)**
- Text input for path
- Helper: "Absolute path to a GGUF or Safetensors LoRA adapter. Must match the base model's architecture."

**7. Few-shot Messages (MESSAGE)**
- Add user/assistant message pairs
- Drag to reorder
- Helper: "Seeds the model's context with example conversations to guide its behavior."

**8. License (LICENSE)**
- Textarea, collapsed by default

**9. Requires (REQUIRES)**
- Text input for minimum Ollama version e.g. `0.6.0`

---

#### Raw Mode

- Full textarea with monospace font, line numbers
- Syntax: comments (`#`) shown in muted color, instructions (`FROM`, `PARAMETER`, etc.) highlighted
- Parses and validates on blur — shows inline errors for unknown instructions
- "Format" button cleans up whitespace

---

#### Sync between modes

- Guided → Raw: always live-syncs (generates Modelfile text from form state)
- Raw → Guided: parses on tab switch, warns if any raw content can't be represented in guided mode

---

#### Bottom action bar (sticky)

- Left: "Preview Modelfile" button → shows modal with final Modelfile text + copy button
- Right: 
  - Model name input (required for create, pre-filled for edit)
  - "Create Model" / "Update Model" button → calls `/api/ollama/create` with SSE progress
  - Progress shown inline: status text + spinner

---

## Design system

Follow boolab's exact Tailwind + shadcn/ui patterns:
- Dark background: `bg-background`
- Cards: `rounded-lg border border-border bg-card p-4`
- Inputs: `h-9 rounded-md border border-border bg-background px-2 text-foreground outline-none ring-ring focus-visible:ring-2`
- Buttons: use shadcn `<Button>` component
- Muted text: `text-muted-foreground`
- Accent: `text-primary` / `bg-primary`
- Sections: `space-y-6`
- Helper text: `text-xs text-muted-foreground mt-1`

---

## Sidebar navigation

Add to the existing sidebar:
```
Models          → /models
Running         → /running
Create Model    → /models/create
[divider]
Personas        → /personas      (Phase 2 stub — disabled for now)
Multi-GPU       → /gpu           (Phase 5 stub — disabled for now)
RAG             → /rag           (Phase 6 stub — disabled for now)
Agents          → /agents        (Phase 7 stub — disabled for now)
```

Disabled items shown with `opacity-50 cursor-not-allowed` and "(soon)" label.

---

## Constraints
- All Ollama API calls go through the FastAPI backend — never call Ollama directly from the frontend
- No auth on this app — Tailscale handles access
- Backend uses `require_admin` on all write endpoints as a safety guard (token passed from frontend via Authorization header using the boolab owner JWT stored in localStorage)
- Never hardcode Ollama URL — always use `OLLAMA_URL` env var
- Pull and create endpoints must use SSE streaming — do not poll
- Mobile: all pages must be fully usable on mobile (responsive layout, no overflow clipping)
- File outputs: backend at `/opt/ollamactl/backend/`, frontend at `/opt/ollamactl/frontend/`
- Deploy: `docker compose up --build -d`
