# OllamaCtl — Phase 1: Core Model Management
Last updated: March 2026

---

## Goal
Bootstrap the project and deliver a fully functional model management UI. After Phase 1, OllamaCtl is deployable and usable as a replacement for the AI → Ollama tab in boolab.

---

## Deliverables

### Infrastructure
- `/opt/ollamactl/` repo scaffold with `docker-compose.yml`
- `backend/` — FastAPI app
- `frontend/` — React/Vite app
- Caddy block for `ai.boogaardmusic.com`
- Auth middleware using boolab JWT cookie

### Pages / Features
1. **Shell** — top nav, sidebar, routing
2. **Local Models** — list with sort/filter, model detail drawer, delete
3. **Pull Model** — streaming pull with progress, HF URL support
4. **Create / Edit Model** — guided Modelfile builder + raw mode
5. **Running Models** — VRAM monitor, per-model unload, unload all
6. **Version & Updates** — current vs latest Ollama version, changelog

---

## Backend Routes (`/opt/ollamactl/backend/`)

### `GET /api/models`
Proxies `GET http://OLLAMA_URL/api/tags`. Returns model list with details.

### `GET /api/models/{name}/detail`
Proxies `POST http://OLLAMA_URL/api/show` with `{"name": name}`. Returns full model info including Modelfile.

### `DELETE /api/models/{name}`
Proxies `DELETE http://OLLAMA_URL/api/delete`.

### `POST /api/models/pull`
SSE streaming proxy to `POST http://OLLAMA_URL/api/pull`. Same pattern as boolab's pull endpoint.

### `POST /api/models/create`
Proxies `POST http://OLLAMA_URL/api/create` with `{"name": name, "modelfile": modelfile_string}`.

### `GET /api/models/running`
Proxies `GET http://OLLAMA_URL/api/ps`. Returns list of loaded models with VRAM usage.

### `POST /api/models/unload`
Body: `{"name": "model_name"}`. Posts `{"model": name, "keep_alive": 0}` to Ollama `/api/generate`.

### `POST /api/models/unload-all`
Fetches `/api/ps`, unloads each loaded model.

### `GET /api/version`
Proxies `GET http://OLLAMA_URL/api/version`. Also fetches latest from `https://api.github.com/repos/ollama/ollama/releases/latest`.

### `GET /api/notes/{model_name}`
Returns model notes from SQLite `model_notes` table.

### `PUT /api/notes/{model_name}`
Upserts notes + tags into `model_notes` table.

### `GET /api/auth/me`
Proxies to boolab API `GET /api/auth/me` using the JWT cookie. Returns user info or 401.

---

## Frontend Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/` | Redirect to `/models` | — |
| `/models` | `ModelsPage` | Local models list |
| `/models/create` | `CreateModelPage` | Guided + raw Modelfile builder |
| `/models/:name` | `ModelDetailPage` | Info / Modelfile / Notes drawer |
| `/models/pull` | `PullModelPage` | Pull with streaming progress |
| `/models/running` | `RunningModelsPage` | VRAM monitor |
| `/system/version` | `VersionPage` | Ollama version + changelog |

---

## Key Components

### `ModelfileEditor`
- Textarea with `Share Tech Mono` font
- Syntax highlighting for Modelfile keywords (`FROM`, `PARAMETER`, `TEMPLATE`, `SYSTEM`, `STOP`)
- "Load from model" button — fetches existing model's Modelfile and populates editor
- Real-time Modelfile preview when in guided mode

### `GuidedModelForm`
Sections (all collapsible):
- **FROM** — text input + "Pick local model" dropdown. Helper: "The base model this config builds on. Can be a local model name or a Hugging Face GGUF URL."
- **Name** — text input. Helper: "What you'll call this model in Ollama. Use lowercase with colons for tags: `mymodel:latest`"
- **System Prompt** — textarea. Helper: "Instructions given to the model before every conversation. Defines personality, constraints, and behavior."
- **Template** — select: ChatML / Llama3 / Alpaca / Raw. Helper: "The prompt format expected by the model. Wrong template = garbled output. ChatML is correct for Qwen models."
- **Parameters** — sliders with inline explainers:
  - Temperature (0–2): "Controls randomness. Lower = more focused and deterministic. 0.6 recommended for these models."
  - Top-P (0–1): "Nucleus sampling. 0.95 = consider tokens making up the top 95% of probability mass."
  - Top-K (1–100): "Limit sampling pool to top K tokens. 20 = only sample from the 20 most likely next tokens."
  - Repeat Penalty (0.5–2): "Penalizes recently used tokens to reduce repetition. 1.0 = no penalty."
  - Max Tokens (128–8192): "Maximum number of tokens the model can generate per response."
- **Stop Tokens** — tag input. Auto-populated per template. Helper: "Tokens that tell the model to stop generating. Must match what's in the template."
- **Advanced** — num_ctx, num_gpu, num_thread with explanations.

### `PullProgressBar`
- Segments: manifest → layers (N) → verification → done
- Shows current layer number + total bytes
- Cancel button aborts the SSE stream

### `RunningModelCard`
- Model name
- VRAM bar: `used / total GB`
- Expires in: countdown from `expires_at`
- Unload button (individual)

### `VersionCard`
- Current version badge
- Latest version + release date
- "Up to date" (green) or "Update available" (amber) status
- Changelog accordion (fetched from GitHub releases API)
- Update instructions: shows NSSM service commands for sam-desktop

---

## Modelfile Templates

Pre-built templates for the guided form dropdown:

### ChatML (Qwen / most HF models)
```
{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{- range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}<|im_start|>assistant
```
Stop tokens: `<|im_start|>`, `<|im_end|>`, `<|endoftext|>`

### Llama3
```
{{- if .System }}<|start_header_id|>system<|end_header_id|>
{{ .System }}<|eot_id|>
{{ end }}{{- range .Messages }}<|start_header_id|>{{ .Role }}<|end_header_id|>
{{ .Content }}<|eot_id|>
{{ end }}<|start_header_id|>assistant<|end_header_id|>
```
Stop tokens: `<|eot_id|>`, `<|end_of_text|>`

### Alpaca
```
{{ if .System }}### System:
{{ .System }}
{{ end }}{{ range .Messages }}### {{ if eq .Role "user" }}Human{{ else }}Assistant{{ end }}:
{{ .Content }}
{{ end }}### Assistant:
```
Stop tokens: `### Human:`, `### System:`

---

## Cursor Context Files for Phase 1
- `CONTEXT.md`
- `DB_SCHEMA.md`
- `UI_DESIGN.md`
- `IMPLEMENTATION_PLAN.md`

No existing source files needed — this phase bootstraps from scratch.

---

## Estimated Cursor Sessions
2 sessions: Session 1 = backend + scaffold + auth. Session 2 = frontend pages.

---

## Deploy Checklist
- [ ] Repo created at `git@github.com:indifferentketchup/ollamactl.git`
- [ ] `/opt/ollamactl/` cloned on homelab
- [ ] `.env` created with `OLLAMA_URL`, `BOOLAB_API_URL`, `JWT_SECRET`, `DB_PATH`
- [ ] `docker compose up --build -d`
- [ ] Caddy block added for `ai.boogaardmusic.com`
- [ ] Auth verified: login via boolab cookie works
- [ ] Models list loads from sam-desktop Ollama
