# OllamaCtl — Master Implementation Plan
Last updated: March 2026

---

## What it is

OllamaCtl is a standalone Ollama control plane and AI management dashboard. It lives at `ai.boogaardmusic.com`, runs as its own Docker stack at `/opt/ollamactl/`, and syncs personas and settings directly with the boolab API. It is not a chat app — it is the admin and configuration layer for the entire homelab AI stack.

---

## Architecture

### Stack
- **Frontend:** React 18 + Vite + Tailwind + shadcn/ui (same component library as boolab)
- **Backend:** FastAPI + uvicorn, Python 3.12
- **Database:** SQLite at `/data/ollamactl.db` (agents, flows, RAG configs — no Postgres dep)
- **Ollama target:** `http://100.101.41.16:11434` (sam-desktop via Tailscale)
- **Boolab API:** `http://100.114.205.53:9300` (persona sync, auth passthrough)

### Containers
| Container | Port | Role |
|-----------|------|------|
| `ollamactl_api` | `8700` | FastAPI backend |
| `ollamactl_ui` | `8701` | React/Vite frontend (nginx) |

### Caddy
```
ai.boogaardmusic.com {
    reverse_proxy 100.114.205.53:8701
}
```
API calls from the frontend go to `/api/*` which Caddy strips and proxies to `8700`.

### Auth
- Reuses boolab JWT cookie (`domain=.boogaardmusic.com`) — no separate login
- All routes require `owner` or `super_admin` role
- No member/guest access — this is an admin-only tool

### Repo
- `git@github.com:indifferentketchup/ollamactl.git`
- Default branch: `main`
- Deploy path: `/opt/ollamactl/`

---

## Phase Overview

| Phase | Name | Status |
|-------|------|--------|
| 1 | Core Model Management | 🔲 Not started |
| 2 | Persona Sync | 🔲 Not started |
| 3 | Multi-GPU + Quantization | 🔲 Not started |
| 4 | Model Import | 🔲 Not started |
| 5 | RAG Control | 🔲 Not started |
| 6 | Agent + Flow Builder | 🔲 Not started |

---

## Reference Files Needed in Cursor

When starting any phase, include these files in Cursor context:

**Always include:**
- `CONTEXT.md` (this project)
- `DB_SCHEMA.md`
- `backend/main.py`
- `backend/routers/ollama.py`
- `frontend/src/App.jsx`

**Phase-specific additions listed in each phase doc.**

---

## Homelab Reference

| Thing | Value |
|-------|-------|
| Ollama host | `100.101.41.16:11434` (sam-desktop) |
| Boolab API | `100.114.205.53:9300` |
| Ubuntu homelab | `100.114.205.53` (samkintop) |
| Deploy path | `/opt/ollamactl/` |
| Push from | Cursor (Windows PowerShell) |
| Pull + rebuild | Termius on ubuntu-homelab |
| Rebuild cmd | `cd /opt/ollamactl && git pull && docker compose up --build -d` |
