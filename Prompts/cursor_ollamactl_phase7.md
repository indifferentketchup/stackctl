# Cursor Prompt — ollamactl Phase 7: Agent Builder

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `src/App.jsx`
- `backend/main.py`
- `backend/routers/ollama.py`
- `backend/routers/personas.py` (Phase 3 output)

Do not touch any file not explicitly listed below.

---

## Context
An "agent" in ollamactl is a named configuration that combines: a base model, a system prompt, a set of tools, and memory settings. Agents are stored in SQLite. They can be tested directly in this UI, and exported as boolab DAW-compatible system prompts or as n8n workflow JSON.

Tools are pre-built integrations. The UI lets you configure which tools the agent can use and with what parameters.

---

## Backend (`backend/routers/agents.py`) — NEW FILE

### SQLite schema
```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',  -- JSON array of tool configs
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
  messages TEXT NOT NULL DEFAULT '[]',  -- JSON array of message history
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Endpoints

**`GET /api/agents`** — list all agents
**`POST /api/agents`** — create agent
**`GET /api/agents/{id}`** — get agent
**`PUT /api/agents/{id}`** — update agent
**`DELETE /api/agents/{id}`** — delete agent

**`POST /api/agents/{id}/run`**
- Body: `{ message: str, run_id: str | null }`
- If `run_id` null: creates new run, returns run_id
- Loads message history from `agent_runs` for that run_id
- Assembles system prompt + tool definitions + history
- Calls Ollama `/api/chat` with streaming (SSE)
- Saves assistant response to run history
- Returns SSE stream of: `{ type: "token", content: "..." }` | `{ type: "tool_call", tool: "...", args: {...} }` | `{ type: "tool_result", tool: "...", result: "..." }` | `{ type: "done" }`

**`GET /api/agents/{id}/runs`** — list runs for an agent
**`DELETE /api/agents/{id}/runs/{run_id}`** — delete a run

**`POST /api/agents/{id}/export-daw`**
- Generates a boolab DAW-compatible JSON payload
- Calls boolab API `POST {BOOLAB_API_URL}/api/daws/` to create the DAW
- Returns the created DAW object

**`POST /api/agents/{id}/export-n8n`**
- Generates an n8n workflow JSON from the agent definition
- Returns the JSON (downloadable)

All write endpoints require `require_admin`.
Register in `backend/main.py` with prefix `/api/agents`.

---

## Tool Definitions

Tools are defined in `backend/tools/registry.py`. Each tool has: id, name, description, parameters schema, and an execute function.

### Built-in tools

**`web_search`**
- Config: `searxng_url` (default from env `SEARXNG_URL`), `max_results` (default 5)
- Calls SearXNG JSON API
- Returns list of `{ title, url, snippet }`

**`caldav_read`**
- Config: `caldav_url`, `username`, `password`, `calendar_name`, `days_ahead` (default 7)
- Reads upcoming events from Baikal CalDAV
- Returns list of events with title, start, end, description

**`http_request`**
- Config: `allowed_domains` (list), `timeout` (default 10)
- Makes GET/POST requests to configured domains only
- Returns response body (truncated to 2000 chars)

**`boolab_rag`**
- Config: `daw_id` (which 808notes DAW to query)
- Calls boolab's RAG retrieval for the specified DAW
- Returns top chunks from ChromaDB

**`file_read`**
- Config: `allowed_paths` (list of base paths on homelab)
- Reads text files from allowed paths only
- Returns file content (truncated to 4000 chars)

---

## Frontend

### `src/pages/AgentsPage.jsx` — NEW FILE

**Header:** "Agents" + "New Agent" button

**Agent list:** Cards with name, description, model badge, tool count, last run timestamp.

Actions per card: Edit | Run | Export to DAW | Export to n8n | Delete

---

### `src/pages/AgentEditorPage.jsx` — NEW FILE

Route: `/agents/new` and `/agents/:id`

**Header:** "New Agent" / "Edit Agent: {name}" + back button + Save button

**Tabs:** Config | Tools | Test

---

#### Tab 1: Config

Fields:
- **Name** — text input
- **Description** — short text input
- **Base Model** — dropdown of local Ollama models
- **System Prompt** — large textarea with char count
  - "Build from persona" button → dropdown of boolab personas → fills system prompt from selected persona's system_prompt
  - "Insert tool instructions" button → appends standard tool-use instructions to system prompt
- **Inference params** — same sliders as ModelfilePage: temperature, top_k, top_p, num_ctx
- **Memory** — toggle + window size slider (1–50 messages)
  - Explanation: "When enabled, the agent remembers the last N messages across runs."

---

#### Tab 2: Tools

List of all available tools. Each tool has:
- Toggle to enable/disable
- When enabled: shows configuration fields specific to that tool
- Description of what the tool does + example output

**web_search config:**
- Max results: slider 1–10
- Note: "Uses SearXNG at {SEARXNG_URL}"

**caldav_read config:**
- Calendar name: text input
- Days ahead: number 1–30
- Note: "Uses Baikal CalDAV at {CALDAV_URL}"

**http_request config:**
- Allowed domains: add/remove list
- Timeout: number (seconds)

**boolab_rag config:**
- DAW picker: dropdown fetching DAWs from boolab API
- Note: "Retrieves from 808notes RAG sources for the selected DAW"

**file_read config:**
- Allowed paths: add/remove list
- Warning: "Only add paths you trust. The agent will be able to read any file under these paths."

---

#### Tab 3: Test Console

**Left panel:** Chat interface
- Message input + send button
- Conversation history showing user messages + assistant responses
- Tool calls shown as expandable cards:
  ```
  🔧 web_search called
  Args: { query: "latest ollama release" }
  ▶ Show result
  ```
- Streaming responses

**Right panel:** Run info
- Current run ID
- Message count
- Model being used
- "New run" button (clears history)
- "Delete run" button

---

### Export flows

**Export to DAW:**
- Confirm dialog: "This will create a new DAW in boolab's BooOps mode with this agent's system prompt and model."
- Shows which DAW was created on success with a link to `booops.boogaardmusic.com/daws/{id}`

**Export to n8n:**
- Downloads a `.json` file
- Shows instructions: "Import this in b2b (n8n) via Workflow → Import from File"

---

## Constraints
- Tool execution happens on the backend only — never expose tool credentials to frontend
- Agent runs are stored in SQLite — not in boolab's DB
- The test console uses SSE streaming — same pattern as existing chat streams
- Tool calls use Ollama's native tool_calls format when the model supports it; fall back to parsing `<tool_call>` XML tags for models that don't
- Mobile: editor tabs collapse, test console stacks vertically
- Enable Agents nav item in sidebar
