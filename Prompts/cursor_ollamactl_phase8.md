# Cursor Prompt — ollamactl Phase 8: Flow Builder

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `src/App.jsx`
- `backend/main.py`
- `backend/routers/agents.py` (Phase 7 output)

Do not touch any file not explicitly listed below.

---

## Context
Flows are visual pipelines that chain agents, tools, and logic together. They are built on React Flow (already in dependencies). Flows are stored as JSON in SQLite and can be executed step-by-step with a trace viewer. They can also be exported to n8n workflow JSON for running in b2b.

---

## Dependencies to add

Frontend:
```bash
npm install reactflow @reactflow/background @reactflow/controls @reactflow/minimap
```

---

## Backend (`backend/routers/flows.py`) — NEW FILE

### SQLite schema
```sql
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',  -- React Flow JSON
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending | running | completed | failed
  trace TEXT NOT NULL DEFAULT '[]',  -- JSON array of step results
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

**`POST /api/flows/{id}/run`**
- Body: `{ input: str }`
- Creates a flow run record
- Executes flow nodes in topological order
- Each node execution appends to `trace`
- Returns SSE stream: `{ type: "node_start", node_id: "..." }` | `{ type: "node_output", node_id: "...", output: "..." }` | `{ type: "node_error", node_id: "...", error: "..." }` | `{ type: "done", output: "..." }`

**`GET /api/flows/{id}/runs`** — list runs for a flow
**`GET /api/flows/{id}/runs/{run_id}`** — get full trace for a run

**`POST /api/flows/{id}/export-n8n`**
- Converts flow definition to n8n workflow JSON
- Returns JSON

All write endpoints require `require_admin`.
Register in `backend/main.py` with prefix `/api/flows`.

---

## Node Types

Define in `backend/flow_nodes/`:

**`input_node`**
- Takes the initial user input
- Output: `{ text: str }`

**`llm_node`**
- Config: model, system_prompt, temperature, top_k, top_p, num_ctx
- Input: text (concatenates with system prompt)
- Calls Ollama `/api/chat`
- Output: `{ text: str }`

**`agent_node`**
- Config: agent_id (reference to agents table)
- Input: text
- Runs the full agent (with tools)
- Output: `{ text: str, tool_calls: [...] }`

**`tool_node`**
- Config: tool_id (from tool registry), tool_params
- Input: text (passed as tool argument)
- Executes the tool
- Output: `{ result: str }`

**`condition_node`**
- Config: condition_type (`contains` | `starts_with` | `regex` | `length_gt`), condition_value
- Input: text
- Output: routes to `true` edge or `false` edge

**`transform_node`**
- Config: template string with `{{input}}` placeholder
- Input: text
- Output: `{ text: str }` with template applied

**`output_node`**
- Terminal node
- Input: text
- Records as flow output

---

## Frontend

### `src/pages/FlowsPage.jsx` — NEW FILE

**Header:** "Flows" + "New Flow" button

**Flow list:** Cards with name, description, node count, last run status + timestamp.

Actions per card: Edit | Run | Export to n8n | Delete

---

### `src/pages/FlowEditorPage.jsx` — NEW FILE

Route: `/flows/new` and `/flows/:id`

**Layout:** Split — left sidebar (node palette + properties) | center canvas | right panel (run trace)

---

#### Left sidebar

**Node palette** — drag to add:
- 📥 Input
- 🤖 LLM
- 👾 Agent (dropdown of saved agents)
- 🔧 Tool (dropdown of tool registry)
- 🔀 Condition
- 🔄 Transform
- 📤 Output

**Properties panel** (shown when a node is selected):
- Node-specific config fields
- Same input patterns as AgentEditorPage (sliders, dropdowns, textareas)

---

#### Center canvas (React Flow)

- Nodes displayed with color coding by type:
  - Input: blue
  - LLM: purple
  - Agent: magenta
  - Tool: green
  - Condition: amber (two output handles: ✓ true, ✗ false)
  - Transform: teal
  - Output: gray

- Each node shows:
  - Type icon + label
  - Key config summary (e.g. model name for LLM node)
  - Status indicator during run: idle | running (spinner) | done (checkmark) | error (X)

- Controls: zoom in/out, fit view, minimap toggle

- Toolbar: Flow name (editable inline) | Save | Run | Export to n8n | Undo/Redo

---

#### Right panel: Run Trace

Shows when a run is in progress or a past run is selected.

**Run input field:** textarea + "Run" button at top.

**Trace timeline:**
- Each step shown as a card in order:
  - Node name + type icon
  - Status: running / completed / failed
  - Input text (collapsible)
  - Output text (collapsible)
  - Duration (ms)
  - Error message if failed

**Past runs list:** dropdown to select and view previous run traces.

---

### n8n Export format

Convert flow to n8n workflow JSON:
- `input_node` → n8n Manual Trigger or Webhook node
- `llm_node` → n8n HTTP Request node (POST to `{OLLAMA_URL}/api/chat`)
- `agent_node` → n8n HTTP Request node (POST to `{OLLAMACTL_URL}/api/agents/{id}/run`)
- `tool_node` → n8n HTTP Request or Function node (depending on tool)
- `condition_node` → n8n IF node
- `transform_node` → n8n Set node
- `output_node` → n8n Set or Respond to Webhook node

Returns JSON that can be imported directly into b2b (n8n at `100.114.205.53:5678`).

Show instructions after export: "Import in b2b: Workflow → Import from File → select the downloaded .json"

---

## Constraints
- React Flow canvas must be contained within its parent div — do not let it overflow the page
- Flow execution is synchronous per node (no parallel branches in Phase 8)
- Condition node creates two output edges — both must be connected for the flow to validate
- Flow validation before run: every non-terminal node must have at least one outgoing edge; every non-source node must have at least one incoming edge
- Mobile: canvas is touch-enabled (React Flow supports this natively), sidebar collapses to bottom drawer
- Enable Flows nav item in sidebar
- Rename sidebar item from "Flows" to "Flows (beta)" — this is experimental
