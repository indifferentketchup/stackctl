# OllamaCtl — Project Context
Last updated: March 2026

---

## What it is
Standalone Ollama control plane and AI management dashboard at `ai.boogaardmusic.com`. Admin-only. Syncs personas with boolab. Manages Ollama models, agents, flows, RAG configs, and GPU settings.

## Location
- Stack: `/opt/ollamactl/` on ubuntu-homelab (`100.114.205.53`)
- Public URL: `https://ai.boogaardmusic.com`
- Backend API: `100.114.205.53:8700`
- Frontend: `100.114.205.53:8701`
- Compose: `/opt/ollamactl/docker-compose.yml`

## Stack
- Frontend: React 18 + Vite + Tailwind + shadcn/ui
- Backend: FastAPI + uvicorn, Python 3.12
- DB: SQLite at `/data/ollamactl.db`
- Ollama: `http://100.101.41.16:11434` (sam-desktop, Tailscale)
- Boolab API: `http://100.114.205.53:9300` (persona/auth sync)

## Auth
- Reuses boolab JWT cookie (`domain=.boogaardmusic.com`)
- Owner/super_admin only — no member or guest access
- Auth check: `GET /api/auth/me` on boolab API, verify role

## Env vars
| Var | Value |
|-----|-------|
| `OLLAMA_URL` | `http://100.101.41.16:11434` |
| `BOOLAB_API_URL` | `http://100.114.205.53:9300` |
| `JWT_SECRET` | shared with boolab |
| `DB_PATH` | `/data/ollamactl.db` |
| `FRONTEND_PATH` | `/app/frontend` |

## Caddy (on droplet `/opt/caddy/Caddyfile`)
```
ai.boogaardmusic.com {
    handle /api/* {
        uri strip_prefix /api
        reverse_proxy 100.114.205.53:8700
    }
    handle {
        reverse_proxy 100.114.205.53:8701
    }
}
```

## Repo
- `git@github.com:indifferentketchup/ollamactl.git`
- Default branch: `main`
- SSH key on homelab: `~/.ssh/id_ed25519_github`

## Deploy pattern
```bash
cd /opt/ollamactl && git pull && docker compose up --build -d
```
Frontend-only changes: rebuild `ollamactl_ui` only.
Backend changes: rebuild `ollamactl_api` only.

## Branding / Theme
- App name: **OllamaCtl** (or customizable)
- Colors: dark background `#0a0a0a`, accent magenta `#e91e8c`, secondary purple `#7c3aed`
- Fonts: Rajdhani (headings/UI), Inter (body)
- Matches boolab aesthetic — cyberpunk dark, no light mode needed
- Tailscale-only access — no public exposure except through Caddy with boogaardmusic.com TLS

## Ollama API reference (sam-desktop)
- Base: `http://100.101.41.16:11434`
- `GET /api/tags` — list models
- `GET /api/ps` — running models
- `POST /api/pull` — pull model (streaming)
- `DELETE /api/delete` — delete model
- `POST /api/create` — create model from Modelfile
- `POST /api/show` — model details + Modelfile
- `GET /api/version` — Ollama version
- `POST /api/generate` — generate (used for keep_alive unload)
- `POST /api/chat` — chat

## Boolab API reference (shared)
- Base: `http://100.114.205.53:9300`
- `GET /api/personas/` — list all personas
- `POST /api/personas/` — create persona
- `PUT /api/personas/{id}` — update persona
- `DELETE /api/personas/{id}` — delete persona
- `POST /api/personas/{id}/icon` — upload persona icon
- `GET /api/auth/me` — verify JWT, get role

## Key design decisions
- No separate auth — piggybacks boolab JWT cookie
- SQLite only — agents/flows don't need Postgres
- All Ollama calls proxied through FastAPI backend (CORS, auth enforcement)
- Streaming responses (pull progress, model load) via SSE same pattern as boolab
- Mobile-first layout — control panel accessible on phone
