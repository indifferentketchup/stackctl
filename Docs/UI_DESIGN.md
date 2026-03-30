# OllamaCtl — UI Design Spec
Last updated: March 2026

---

## Design Language

### Theme
- **Mode:** Dark only. No light mode toggle.
- **Background:** `#0a0a0a` (root), `#111111` (cards/panels), `#1a1a1a` (inputs)
- **Accent:** Magenta `#e91e8c` (primary actions, active states, progress)
- **Secondary accent:** Purple `#7c3aed` (tags, badges, secondary buttons)
- **Text:** `#f4f4f4` (primary), `#888` (secondary/muted), `#555` (disabled)
- **Border:** `#222` (default), `#333` (hover)
- **Destructive:** `#ef4444`
- **Success:** `#22c55e`
- **Warning:** `#f59e0b`

### Typography
- **Headings / UI labels:** Rajdhani (Google Fonts)
- **Body / descriptions:** Inter (Google Fonts)
- **Code / Modelfiles / paths:** `Share Tech Mono` or `JetBrains Mono`
- **Base size:** 14px
- **Nav labels:** 13px uppercase tracking-wide

### Component style
- Border radius: `8px` (cards), `6px` (inputs/buttons), `4px` (badges)
- Buttons: solid magenta for primary, dark outline for secondary, red for destructive
- Inputs: dark background `#1a1a1a`, `1px solid #333`, focus ring magenta
- Cards: `#111` background, `1px solid #222` border, `8px` radius, `16px` padding
- Shadows: subtle `0 2px 8px rgba(0,0,0,0.4)` — no heavy drop shadows
- No gradients on interactive elements. Gradients OK for hero/empty states only.

---

## Layout

### Shell
```
┌─────────────────────────────────────────────────────┐
│ [Logo] OllamaCtl          [Status pill] [User menu] │  ← Top nav bar (56px)
├──────────┬──────────────────────────────────────────┤
│          │                                          │
│  Sidebar │  Main content area                       │
│  (240px) │                                          │
│          │                                          │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

### Top nav
- Left: Logo icon + "OllamaCtl" wordmark
- Center: Ollama connection status pill (`● Connected v0.6.8` or `● Disconnected`)
- Right: User avatar/name dropdown (shows current user from boolab JWT)

### Sidebar
- Width: 240px desktop, collapsible to 56px icon-only
- Mobile: slides in as overlay
- Nav sections:
  - **Models** — Local Models, Running Models, Pull Model, Create Model, Import Model
  - **Personas** — All Personas, Create Persona
  - **Agents** — All Agents, Create Agent
  - **Flows** — All Flows, Create Flow
  - **RAG** — Configs, Documents
  - **Hardware** — GPU Config, Quantization
  - **System** — Ollama Config, Version & Updates, Settings

### Mobile
- Bottom tab bar replaces sidebar on `< 768px`
- Tabs: Models | Personas | Agents | RAG | System
- Full-screen modals for create/edit forms
- All tables become stacked cards on mobile

---

## Page Designs

### Local Models (`/models`)
- Table view: Name | Size | Params | Quant | Modified | Actions
- Sort by: Name / Size / Modified (toggle)
- Search/filter bar at top
- Action buttons per row: `ⓘ Details` | `✎ Edit` | `⟳ Update` | `🗑 Delete`
- Bulk select + bulk delete
- "Create Model" and "Pull Model" buttons top-right
- Empty state: illustration + "No models yet. Pull one to get started."

### Model Detail drawer/modal
Slides in from right (desktop) or full-screen (mobile):
- Model name + size badge + quant badge
- Tabs: **Info** | **Modelfile** | **Notes**
- Info tab: parameter count, family, context length, modified date, license
- Modelfile tab: syntax-highlighted read-only view + "Edit" button to open editor
- Notes tab: free-text textarea, saved to `model_notes` table

### Create/Edit Model (`/models/create`)
Guided form with two modes — **Guided** (default) and **Raw** (Modelfile textarea):

**Guided mode sections:**
1. **Base** — "FROM" field with autocomplete from local models list + HF URL input
2. **Identity** — Model name, description
3. **System Prompt** — Large textarea with placeholder examples
4. **Template** — Dropdown: ChatML / Llama3 / Alpaca / Custom. Shows preview. Custom = raw textarea.
5. **Parameters** — Sliders: Temperature, Top-P, Top-K, Repeat Penalty, Max Tokens. Each slider has a plain-English tooltip explaining what it does.
6. **Stop Tokens** — Tag input. Pre-fill based on template selection.
7. **Advanced** — Num CTX, Num GPU, Num Thread

Each section has a collapsible "What is this?" helper text.

**Raw mode:** Full Modelfile textarea with syntax highlighting. Includes "Load from existing model" dropdown.

Generates Modelfile preview in real time as user edits guided fields.

### Pull Model (`/models/pull`)
- Input: model name (e.g. `llama3.2:latest`, `hf.co/user/repo:tag`)
- Examples listed: quick-pull chips for common models
- Progress: SSE streaming progress bar per layer with status text
- History: recent pulls list (from model_notes table, last 10)

### Running Models (`/models/running`)
- Cards per loaded model:
  - Model name + size
  - VRAM usage bar (used / total)
  - Expires in countdown
  - "Unload" button
- "Unload All" button at top
- Auto-refreshes every 10s
- Empty state: "No models currently in VRAM"

### Personas (`/personas`)
- Same card grid as boolab AI settings
- Syncs directly with `boolab API /api/personas/`
- Shows: avatar | name | system prompt preview | default badges
- Actions: Edit | Set Default (BooOps) | Set Default (808notes) | Delete
- Create button top-right
- "Synced with boolab" indicator showing last sync time

### Create/Edit Persona
Full-page form:
- Emoji picker + image upload
- Name field
- System prompt textarea (large, with character count)
- "Test this persona" button — opens mini chat panel using selected model
- Default for BooOps toggle
- Default for 808notes toggle

### Agents (`/agents`)
- Card grid: Name | Model | Tools | Description
- Click to open detail/edit
- Create button top-right

### Agent Detail/Create
- Name, description, color picker, emoji
- Model selector (dropdown from local models)
- System prompt (large textarea)
- Tools section: toggle list of available tools (web search, calculator, code runner, etc.)
- Inference params: Temperature, Top-P, Top-K, Max Tokens, Context Window
- Think mode toggle (for models that support `<think>` tags)
- "Test Agent" panel — mini chat at bottom of page

### GPU Config (`/hardware/gpu`)
- Current config card: shows active GPU profile
- GPU status: detected GPUs with VRAM bars (polling Ollama `/api/ps`)
- Config profiles list: create/edit/activate named profiles
- Profile fields:
  - GPU IDs (checkboxes if multiple detected)
  - KV Cache Type: F16 / Q8_0 / Q4_0 — each option has "What is this?" explainer
  - Flash Attention toggle
  - Max Loaded Models slider
  - Keep Alive input
  - Num Parallel slider
- "Apply Profile" generates env var block + shows restart instructions

### RAG Configs (`/rag`)
- List of named RAG configs
- Click to manage documents in that config
- Create config: name, embedding model, chunk size (slider with token count preview), overlap, top-k sliders
- Document list per config: filename | size | status | chunk count | actions
- Upload document button
- Re-index button per document

### Version & Updates (`/system/version`)
- Current Ollama version
- Latest available version (fetched from GitHub API)
- "Update Available" badge if behind
- Changelog from GitHub releases
- Update instructions (manual — shows NSSM service restart commands for Windows)

---

## Interaction Patterns

### Streaming operations (pull, index)
- SSE progress shown inline in the triggering UI
- Progress bar + status text + cancel button
- On complete: success toast + refresh affected list

### Confirmations
- Destructive actions (delete model, delete persona) require confirm dialog
- Dialog shows exactly what will be deleted
- No "are you sure?" patterns — use clear action labels: "Delete llama3.2:latest permanently"

### Toasts
- Bottom-right, 3s auto-dismiss
- Types: success (green), error (red), info (magenta)

### Empty states
- Every list has an empty state with an icon, headline, and primary action button
- No blank pages

### Loading states
- Skeleton loaders for all list/table views
- Spinner for single-item loads
- Never block the whole page — load sections independently
