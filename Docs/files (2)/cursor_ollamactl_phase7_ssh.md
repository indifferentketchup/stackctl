# Cursor Prompt — ollamactl Phase 7: Agent Builder (SSH-enabled)

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `backend/main.py`
- `backend/routers/modelfile_apply.py` — SSH pattern, follow exactly
- `backend/routers/ollama.py`
- `backend/routers/personas.py`
- `backend/db.py`
- `src/App.jsx`
- `src/components/ApplyTerminalPanel.jsx`

Do not touch any file not explicitly listed below.

---

## Context
Agents are named configurations combining: base model, system prompt, tools, and memory. They are stored in SQLite. They can be tested live (chat runs over SSH → Ollama on sam-desktop), and exported as boolab DAWs or n8n workflows. All Ollama inference goes through SSH to sam-desktop — never directly from the frontend.

SSH pattern: always use `known_hosts=None`, key from `SAMDESKTOP_SSH_KEY` env var, host from `SAMDESKTOP_HOST`, user from `SAMDESKTOP_USER`. Follow `modelfile_apply.py` exactly.

---

## Backend (`backend/routers/agents.py`) — NEW FILE

### SQLite schema (add to `backend/db.py` init):
```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  memory_enabled INTEGER DEFAULT 0,
  memory_window INTEGER DEFAULT 10,
  temperature REAL DEFAULT 0.6,
  top_k INTEGER DEFAULT 20,
  top_p REAL DEFAULT 0.95,
  num_ctx INTEGER DEFAULT 8192,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Endpoints

**`GET /api/agents`** — list all agents
**`POST /api/agents`** — create agent
**`GET /api/agents/{id}`** — get agent
**`PUT /api/agents/{id}`** — update agent
**`DELETE /api/agents/{id}`** — delete agent

All require `require_admin`.

**`POST /api/agents/{id}/run`**
- Body: `{ message: str, run_id: str | null }`
- Creates new run if `run_id` null
- Loads message history from `agent_runs`
- Builds payload: system prompt + tool definitions + history + new message
- **SSHes into sam-desktop** and runs inference via Ollama API over SSH tunnel:
  - Open SSH connection with asyncssh
  - Use local port forwarding: forward `localhost:11434` on the container to `100.101.41.16:11434` via SSH tunnel
  - OR: call Ollama directly at `OLLAMA_URL` (already accessible via Tailscale — no SSH needed for inference, SSH is only needed for `ollama create`/`ollama rm` commands)
  - POST to `{OLLAMA_URL}/api/chat` with streaming
- Saves assistant response to `agent_runs`
- Returns SSE stream:
  - `{ type: "token", content: "..." }`
  - `{ type: "tool_call", tool: "...", args: {...} }`
  - `{ type: "tool_result", tool: "...", result: "..." }`
  - `{ type: "done" }`

**`GET /api/agents/{id}/runs`** — list runs
**`DELETE /api/agents/{id}/runs/{run_id}`** — delete run

**`POST /api/agents/{id}/export-daw`**
- Calls boolab API `POST {BOOLAB_API_URL}/api/daws/` with agent's model + system prompt
- Returns created DAW

**`POST /api/agents/{id}/export-n8n`**
- Generates n8n workflow JSON
- Returns JSON for download

Register in `backend/main.py` with prefix `/api/agents`.

---

## Tool execution (via SSH where needed)

Define in `backend/tools/registry.py` — NEW FILE.

### `web_search`
- Config: `searxng_url`, `max_results`
- Direct HTTP call to SearXNG — no SSH needed
- Returns `[{ title, url, snippet }]`

### `caldav_read`
- Config: `caldav_url`, `username`, `password`, `calendar_name`, `days_ahead`
- Direct HTTP call to Baikal — no SSH needed
- Returns upcoming events

### `http_request`
- Config: `allowed_domains`, `timeout`
- Direct HTTP — no SSH needed
- Returns response body truncated to 2000 chars

### `boolab_rag`
- Config: `daw_id`
- Calls boolab API directly — no SSH needed
- Returns top RAG chunks for the DAW

### `file_read`
- Config: `allowed_paths` (paths on **sam-desktop**)
- **SSHes into sam-desktop** using asyncssh
- Runs: `Get-Content "{path}" -Raw` via SSH
- Returns file content truncated to 4000 chars
- Validates path is under one of `allowed_paths` before executing
- Warning in UI: "Reads files from sam-desktop, not homelab"

### `run_powershell`
- Config: `allowed_commands` (whitelist of command prefixes)
- **SSHes into sam-desktop** using asyncssh
- Runs the command via SSH
- Returns stdout/stderr truncated to 2000 chars
- Only executes if command starts with one of `allowed_commands`
- Warning in UI: "Executes PowerShell on sam-desktop. Use with caution."

---

## Frontend

### `src/pages/AgentsPage.jsx` — NEW FILE

**Header:** "Agents" + "New Agent" button

Cards: name, description, model badge, tool count, last run.
Actions: Edit | Run | Export to DAW | Export to n8n | Delete

---

### `src/pages/AgentEditorPage.jsx` — NEW FILE

Routes: `/agents/new` and `/agents/:id`

**Tabs: Config | Tools | Test**

---

#### Tab 1: Config

- Name, Description
- Base Model — dropdown from `/api/ollama/models`
- System Prompt — textarea with char count
  - "Build from persona" → picks boolab persona → fills system prompt
  - "Insert tool instructions" → appends standard tool-use instructions
- Inference params: temperature, top_k, top_p, num_ctx (same sliders as ModelfilePage)
- Memory toggle + window size (1–50 messages)

---

#### Tab 2: Tools

Each tool: toggle on/off + config fields when enabled.

**web_search:** max results slider, SearXNG URL (pre-filled from env)
**caldav_read:** calendar name, days ahead, note "Uses Baikal CalDAV"
**http_request:** allowed domains list, timeout
**boolab_rag:** DAW picker dropdown
**file_read:** allowed paths list, warning banner "Reads files from sam-desktop via SSH"
**run_powershell:** allowed command prefixes list, warning banner "Executes PowerShell on sam-desktop via SSH — use with caution"

---

#### Tab 3: Test Console

**Left panel:** Chat interface
- Message input + send
- Conversation history
- Tool calls shown as expandable cards:
  ```
  🔧 file_read called via SSH
  Path: D:\myfiles\notes.txt
  ▶ Show result
  ```
- Streaming responses via SSE from `/api/agents/{id}/run`
- SSH status indicator — if sam-desktop unreachable, show warning before allowing run

**Right panel:**
- Run ID
- Message count
- Model in use
- "New run" / "Delete run" buttons

---

### Export flows

**Export to DAW:**
- Confirm: "Create a new DAW in boolab BooOps with this agent's config?"
- Shows link to created DAW on success

**Export to n8n:**
- Downloads `.json`
- Instructions: "Import in b2b at 100.114.205.53:5678 → Workflow → Import from File"

---

## Constraints
- Ollama inference calls go directly to `OLLAMA_URL` (Tailscale accessible) — SSH not needed for chat
- SSH is only needed for `file_read` and `run_powershell` tools
- Follow `modelfile_apply.py` SSH pattern exactly including `known_hosts=None`
- Tool credentials never exposed to frontend
- Agent runs stored in SQLite only
- Mobile: editor tabs collapse, test console stacks vertically
- Enable Agents nav item in sidebar
