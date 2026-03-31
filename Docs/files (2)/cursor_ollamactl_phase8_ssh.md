# Cursor Prompt — ollamactl Phase 8: Flow Builder (SSH-enabled)

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `backend/main.py`
- `backend/routers/modelfile_apply.py` — SSH pattern, follow exactly
- `backend/routers/agents.py` (Phase 7 output)
- `backend/db.py`
- `src/App.jsx`
- `src/components/ApplyTerminalPanel.jsx`

Do not touch any file not explicitly listed below.

---

## Context
Flows are visual pipelines chaining agents, tools, and logic. Built on React Flow. Stored as JSON in SQLite. Executed step-by-step with real-time SSE trace. Exportable to n8n. All Ollama inference goes directly to `OLLAMA_URL` (Tailscale accessible). SSH is used only for tool nodes that execute on sam-desktop (`file_read`, `run_powershell`, `ollama_create`).

SSH pattern: always `known_hosts=None`, key from `SAMDESKTOP_SSH_KEY`, host from `SAMDESKTOP_HOST`, user from `SAMDESKTOP_USER`. Follow `modelfile_apply.py` exactly.

---

## Dependencies to add to `frontend/package.json`:
```
"reactflow": "^11.11.4",
"@reactflow/background": "^11.3.14",
"@reactflow/controls": "^11.2.14",
"@reactflow/minimap": "^11.7.14"
```

---

## Backend (`backend/routers/flows.py`) — NEW FILE

### SQLite schema (add to `backend/db.py` init):
```sql
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  trace TEXT NOT NULL DEFAULT '[]',
  input TEXT,
  output TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Endpoints

**`GET /api/flows`** — list flows
**`POST /api/flows`** — create flow
**`GET /api/flows/{id}`** — get flow with definition
**`PUT /api/flows/{id}`** — update flow
**`DELETE /api/flows/{id}`** — delete flow

All require `require_admin`.

**`POST /api/flows/{id}/run`**
- Body: `{ input: str }`
- Creates flow run record, status = `running`
- Executes nodes in topological order
- Returns SSE stream:
  - `{ type: "node_start", node_id: "...", node_type: "...", node_label: "..." }`
  - `{ type: "node_output", node_id: "...", output: "..." }`
  - `{ type: "node_error", node_id: "...", error: "..." }`
  - `{ type: "done", output: "...", run_id: "..." }`

**`GET /api/flows/{id}/runs`** — list runs
**`GET /api/flows/{id}/runs/{run_id}`** — get full trace

**`POST /api/flows/{id}/export-n8n`**
- Converts flow to n8n workflow JSON
- Returns JSON

Register in `backend/main.py` with prefix `/api/flows`.

---

## Node Types (`backend/flow_nodes/`) — NEW DIRECTORY

### `input_node.py`
- Takes initial user input string
- Output: `{ text: str }`
- No SSH needed

### `llm_node.py`
- Config: model, system_prompt, temperature, top_k, top_p, num_ctx
- Calls `{OLLAMA_URL}/api/chat` directly (Tailscale accessible, no SSH)
- Output: `{ text: str }`

### `agent_node.py`
- Config: agent_id (references agents table)
- Calls agent run logic from `agents.py`
- SSH used only if agent uses `file_read` or `run_powershell` tools
- Output: `{ text: str, tool_calls: [...] }`

### `tool_node.py`
- Config: tool_id, tool_params
- Tool registry from `backend/tools/registry.py` (Phase 7)
- SSH used for `file_read` and `run_powershell` tools
- For SSH tools: SSHes into sam-desktop using asyncssh, `known_hosts=None`
- Output: `{ result: str }`

### `ollama_create_node.py` — NEW (SSH-specific)
- Config: model_name, modelfile_content (or reference to existing model)
- **SSHes into sam-desktop** using asyncssh
- Writes Modelfile via SFTP to `%TEMP%\flow_{uuid}.txt`
- Runs `ollama create {model_name} -f %TEMP%\flow_{uuid}.txt`
- Deletes temp file
- Output: `{ success: bool, model_name: str }`
- Use case: flows that dynamically create/update models as part of automation

### `condition_node.py`
- Config: condition_type (`contains` | `starts_with` | `regex` | `length_gt`), condition_value
- Routes to `true` or `false` edge
- No SSH needed

### `transform_node.py`
- Config: template string with `{{input}}` placeholder
- No SSH needed
- Output: `{ text: str }`

### `http_node.py` — NEW
- Config: url, method, headers, body_template, allowed_domains
- Direct HTTP call (no SSH)
- Output: `{ status: int, body: str }`

### `ssh_command_node.py` — NEW
- Config: command, allowed_command_prefixes
- **SSHes into sam-desktop** using asyncssh, `known_hosts=None`
- Runs PowerShell command
- Validates command against `allowed_command_prefixes`
- Output: `{ stdout: str, stderr: str, exit_code: int }`
- Warning shown in UI: "Executes on sam-desktop via SSH"

### `output_node.py`
- Terminal node
- Records as flow output
- No SSH needed

---

## Frontend

### `src/pages/FlowsPage.jsx` — NEW FILE

**Header:** "Flows" + "New Flow" button

Cards: name, description, node count, last run status + timestamp.
Actions: Edit | Run | Export to n8n | Delete

---

### `src/pages/FlowEditorPage.jsx` — NEW FILE

Routes: `/flows/new` and `/flows/:id`

**Layout:** Left sidebar (palette + properties) | Center canvas | Right panel (run trace)

---

#### Left sidebar

**Node palette** — drag to add:
- 📥 Input
- 🤖 LLM (direct Ollama)
- 👾 Agent
- 🔧 Tool
- 🖥️ SSH Command (sam-desktop) — amber color, warning icon
- 🔨 Ollama Create (sam-desktop) — amber color, SSH icon
- 🌐 HTTP Request
- 🔀 Condition
- 🔄 Transform
- 📤 Output

SSH nodes (SSH Command, Ollama Create) shown with amber background and "SSH" badge in palette to make it clear they run on sam-desktop.

**Properties panel** (shown when node selected):
- Node-specific config fields
- SSH nodes show: SSH status indicator + "Runs on sam-desktop" banner

---

#### Center canvas (React Flow)

Node color coding:
- Input: blue
- LLM: purple
- Agent: magenta
- Tool: green
- SSH Command: amber with SSH badge
- Ollama Create: amber with SSH badge
- HTTP Request: teal
- Condition: yellow (two output handles: ✓ true, ✗ false)
- Transform: cyan
- Output: gray

Each node shows:
- Type icon + label
- Key config summary
- SSH badge on SSH nodes
- Status during run: idle | running (spinner) | done ✓ | error ✗

Toolbar: Flow name (editable) | Save | Run | Export to n8n | Undo/Redo

SSH status indicator in toolbar — if sam-desktop unreachable and flow contains SSH nodes, show warning: "Flow contains SSH nodes but sam-desktop is unreachable"

---

#### Right panel: Run Trace

**Run input:** textarea + "Run" button

**Trace timeline:**
Each step as a card:
- Node name + type icon + SSH badge if applicable
- Status
- Input (collapsible)
- Output (collapsible)
- Duration (ms)
- For SSH nodes: shows SSH connection status in the card

**Past runs:** dropdown to select previous traces.

---

### n8n Export

Convert to n8n workflow JSON:
- `input_node` → Manual Trigger
- `llm_node` → HTTP Request to `{OLLAMA_URL}/api/chat`
- `agent_node` → HTTP Request to `{ollamactl_url}/api/agents/{id}/run`
- `tool_node` → HTTP Request or Function node
- `ssh_command_node` → HTTP Request to `{ollamactl_url}/api/flows/ssh-exec` (ollamactl proxies SSH)
- `ollama_create_node` → HTTP Request to `{ollamactl_url}/api/models/apply`
- `condition_node` → IF node
- `transform_node` → Set node
- `http_node` → HTTP Request node
- `output_node` → Set or Respond to Webhook

Instructions after export: "Import in b2b at `100.114.205.53:5678` → Workflow → Import from File"

---

### `src/api/flows.js` — NEW FILE

API wrappers:
- `listFlows()`, `createFlow()`, `getFlow(id)`, `updateFlow(id, data)`, `deleteFlow(id)`
- `runFlow(id, input)` — returns SSE stream
- `getFlowRuns(id)`, `getFlowRun(id, runId)`
- `exportFlowN8n(id)` — returns JSON blob for download

---

## Validation before run

Before executing a flow, validate:
1. Every non-terminal node has at least one outgoing edge
2. Every non-source node has at least one incoming edge
3. If flow contains SSH nodes and sam-desktop is unreachable: block run with clear error
4. Condition node must have both `true` and `false` edges connected

Show validation errors inline on the canvas (red border on invalid nodes) before allowing run.

---

## Constraints
- React Flow canvas must not overflow its container
- Flow execution is sequential (no parallel branches in this phase)
- SSH always uses `known_hosts=None`, `SAMDESKTOP_SSH_KEY`, `SAMDESKTOP_HOST`, `SAMDESKTOP_USER`
- SSH nodes must be clearly visually distinct from non-SSH nodes
- Mobile: canvas is touch-enabled, sidebar collapses to bottom drawer
- Sidebar nav label: "Flows (beta)"
- Do not change any existing routers or pages
