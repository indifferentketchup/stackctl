# ollamactl

A self-hosted Ollama control plane built on top of boolab's infrastructure. Deployed at `ai.boogaardmusic.com`, accessible via Tailscale only.

---

## What it is

ollamactl is a full-featured web dashboard for managing a remote Ollama instance (sam-desktop at `100.101.41.16:11434`). It is a standalone React/Vite app with a FastAPI backend. Personas sync directly with boolab's PostgreSQL API. Everything else (models, agents, RAG, GPU config) is managed here.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + Tailwind + shadcn/ui |
| Backend | FastAPI + Python 3.12 |
| Database | SQLite (agents, flows, RAG sources, GPU env desired state) |
| Ollama | `100.101.41.16:11434` (sam-desktop, RTX 5090 + 4080 Super) |
| Persona sync | boolab API at `100.114.205.53:9300` |
| Container | Docker Compose at `/opt/ollamactl/` |
| Public URL | `https://ai.boogaardmusic.com` (Caddy → homelab) |
| Auth | Tailscale mesh (no public access) |

---

## Features by phase

### Phase 1 — Model Management
- List all local models with size, quant, param count, modified date
- Pull models from Ollama registry or HuggingFace (`hf.co/` prefix)
  - Real-time SSE pull progress bar
  - Detects double `FROM` (mmproj) bug and warns
- Delete models with confirmation
- Update Ollama binary (checks GitHub releases vs running version)
- Running models monitor: VRAM usage, expiry timer, per-model unload button
- Unload all models button

### Phase 2 — Modelfile Editor
Full guided Modelfile builder with two modes:

**Guided mode** (form-based):
- FROM: dropdown of local models + free-text for GGUF path / HF ref
- SYSTEM: textarea with char count
- TEMPLATE: dropdown of common chat templates (ChatML, Llama3, Mistral, raw) + raw editor
- PARAMETER: sliders/inputs for every valid param with inline docs:
  - `temperature` — creativity vs coherence
  - `top_k` — sampling pool size
  - `top_p` — nucleus sampling
  - `min_p` — minimum token probability
  - `num_ctx` — context window
  - `num_predict` — max output tokens
  - `repeat_penalty` — repetition penalty
  - `repeat_last_n` — lookback for repeat detection
  - `seed` — fixed seed for reproducibility
  - `stop` — stop token strings (add/remove list)
- ADAPTER: path input for LoRA/GGUF adapters
- MESSAGE: conversation history seeder (add user/assistant pairs)
- LICENSE: textarea
- REQUIRES: Ollama minimum version

**Raw mode** (textarea):
- Full Modelfile text editor with syntax highlighting
- Toggle between guided and raw — guided → raw always works, raw → guided parses what it can

- Preview generated Modelfile before creating
- Name + create → calls `POST /api/create` on Ollama
- Edit existing model (loads its current Modelfile via `ollama show --modelfile`)
- Copy model (`ollama cp`) with rename

### Phase 3 — Persona Sync
- Lists all personas from boolab's `/api/personas/` endpoint
- Full CRUD: create, edit, delete
- Fields: name, avatar emoji, avatar image upload, system prompt
- Set default for BooOps / 808notes
- Changes write directly to boolab's PostgreSQL via boolab API
- Real-time sync indicator

### Phase 4 — Model Import
Three import paths:

**From GGUF file:**
- Upload GGUF to sam-desktop shared path or provide absolute path
- Generates Modelfile with correct `FROM /path/to/file.gguf`
- Optional: add ChatML/Llama3/custom template, params, system prompt
- Warns on double `FROM` (mmproj) detection

**From Safetensors:**
- Directory path input (must be accessible from Ollama's filesystem)
- Supported architectures listed: Llama, Mistral, Gemma, Phi3
- Generates `FROM <dir>` Modelfile

**From HuggingFace:**
- `hf.co/<user>/<repo>:<quant>` syntax with quant tag picker
- Fetches repo metadata to show available files before pulling
- Quantization selector with explanations (Q4_K_M recommended, Q8_0 best quality, etc.)

**Quantize on import:**
- Checkbox to quantize during `ollama create`
- Supported: `q8_0`, `q4_K_S`, `q4_K_M`
- Explanation of each with VRAM impact estimate

### Phase 5 — Multi-GPU configuration
**Where it runs:** The dashboard lives on the homelab control plane; Ollama runs on **sam-desktop** (Windows 11) as an **NSSM** service. ollamactl does **not** push env changes to Windows automatically — it shows live Ollama status, stores the **desired** config in SQLite, and generates **PowerShell + nssm** commands you run on sam-desktop.

- **Live status** — `GET {OLLAMA_URL}/api/ps` and `/api/version` via backend `GET /api/gpu/status` (loaded models, VRAM hints, version; GPU names may be sparse depending on Ollama)
- **Hardware reference** — Static summary on the GPU page (RTX 5090 + 4080 Super, NSSM path note)
- **Environment variables** (per-key save into SQLite `gpu_config`):
  - `CUDA_VISIBLE_DEVICES` — which GPUs and order
  - `OLLAMA_GPU_LAYERS` — optional layer offload count (empty = auto)
  - `OLLAMA_MAX_LOADED_MODELS` — concurrent loaded models (1–8)
  - `OLLAMA_KEEP_ALIVE` — retention after last use (`30m`, `1h`, `0`, `-1`, …)
  - `OLLAMA_FLASH_ATTENTION` — on/off
  - `OLLAMA_KV_CACHE_TYPE` — `f16`, `q8_0`, or `q4_0` with VRAM estimate callouts (approximate)
- **Preset strategies** — One-click “Apply” loads stored values for common setups (single GPU, dual-GPU auto-split, two models at once)
- **Apply section** — Renders `nssm set … AppEnvironmentExtra` + `nssm restart` for copying; **Copy commands**, **Mark as applied** (baseline in `gpu_config_baseline`), and **pending changes** when stored config differs from last marked baseline
- Admin-only API: `GET /api/gpu/status`, `GET/PUT /api/gpu/config`, `POST /api/gpu/mark-applied` (`backend/routers/gpu.py`)

### Phase 6 — RAG Control
- Document upload (PDF, DOCX, TXT, MD)
- Chunking config: chunk size, overlap
- Embedding model picker (uses Ollama embeddings)
- ChromaDB collection browser: list, delete collections
- Per-document chunk viewer
- Rerank settings: toggle, top_k before/after rerank
- Connects to boolab's ChromaDB at `boolab_chroma:8000`

### Phase 7 — Agent Builder
- Define agents with: name, system prompt, base model, tools, memory settings
- Tool registry: web search (SearXNG), CalDAV, file read, HTTP request, code execution
- Agent test console: send a message, see tool calls + final response
- Save agents to SQLite, load into boolab as DAW-compatible system prompts

### Phase 8 — Flow Builder
- Visual canvas (React Flow) for chaining agents/tools
- Node types: input, LLM call, tool, condition, output
- Save/load flows as JSON
- Execute flows with step-by-step trace viewer
- Export as n8n workflow JSON (b2b compatible)

---

## Infrastructure

### Deployment
```
/opt/ollamactl/
  docker-compose.yml
  .env
  backend/
    main.py
    routers/
    db.py
  frontend/
    src/
    vite.config.js
    package.json
  Dockerfile.backend
  Dockerfile.frontend
```

### Ports
| Service | Port |
|---|---|
| ollamactl API | `100.114.205.53:8700` |
| ollamactl UI | `100.114.205.53:8701` |

### Caddy block
```
ai.boogaardmusic.com {
    handle /api/* {
        reverse_proxy 100.114.205.53:8700
    }
    handle {
        reverse_proxy 100.114.205.53:8701
    }
}
```

### Environment variables
```
OLLAMA_URL=http://100.101.41.16:11434
BOOLAB_API_URL=http://100.114.205.53:9300
BOOLAB_OWNER_TOKEN=<owner JWT from boolab>
CHROMA_URL=http://100.114.205.53:8000
DB_PATH=/data/ollamactl.db
```

---

## Development workflow

Same as boolab:
1. Code in Cursor on Windows
2. Push to `main` branch at `git@github.com:indifferentketchup/ollamactl.git`
3. Pull + rebuild on homelab via Termius:
```bash
cd /opt/ollamactl && git pull && docker compose up --build -d
```

---

## Auth

No login — Tailscale handles access. Only reachable on the Tailscale mesh. Not exposed publicly via Caddy (or if exposed, IP-restricted to Tailscale exit node range).

---

## Repo

`git@github.com:indifferentketchup/ollamactl.git`  
Default branch: `main`

---

## Related services

| Service | URL | Notes |
|---|---|---|
| boolab API | `100.114.205.53:9300` | Persona sync target |
| Ollama | `100.101.41.16:11434` | sam-desktop inference |
| ChromaDB | `boolab_chroma:8000` | Vector store (Phase 6) |
| b2b (n8n) | `100.114.205.53:5678` | Flow export target (Phase 8) |
| SearXNG | `100.114.205.53:8888` | Agent tool (Phase 7) |
