# OllamaCtl — Phase 6: Agent + Flow Builder
Last updated: March 2026

---

## Goal
Visual agent configuration and multi-step flow builder. Agents are saved model+persona+tool configurations. Flows chain agents together into pipelines with conditions and outputs.

---

## Concepts

### Agent
A named configuration binding a model, system prompt, inference parameters, and a set of tools. Agents can be tested interactively and used as steps in flows.

### Tool
A capability the agent can invoke during generation. Tools are pre-built functions exposed to the model via the system prompt and parsed from model output.

**Available tools (Phase 6):**
- `web_search` — queries SearXNG at `http://100.114.205.53:8888`
- `calculator` — evaluates math expressions
- `date_time` — returns current date/time
- `rag_lookup` — queries a RAG config (picker to select which config)
- `boolab_context` — fetches boolab DAW context via boolab API
- `http_request` — makes an HTTP GET/POST (configurable URL + headers)

### Flow
A linear or branching pipeline of steps. Each step is an agent call, a tool call, a condition branch, or an output formatter. Flows can be triggered manually, on a schedule, or via webhook (n8n integration).

---

## Backend Routes

### Agents
- `GET /api/agents` — list all
- `POST /api/agents` — create
- `PUT /api/agents/{id}` — update
- `DELETE /api/agents/{id}` — delete
- `POST /api/agents/{id}/run` — SSE streaming: run agent with a single message, returns streamed response

### Flows
- `GET /api/flows` — list all
- `POST /api/flows` — create
- `PUT /api/flows/{id}` — update
- `DELETE /api/flows/{id}` — delete
- `POST /api/flows/{id}/run` — SSE streaming: execute flow, returns step-by-step output
- `GET /api/flows/{id}/runs` — run history (last 20 executions)

### Tools
- `GET /api/tools` — list available tools with descriptions and config schema
- `POST /api/tools/test/{tool_name}` — test a tool with sample input

---

## Frontend Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/agents` | `AgentsPage` | Agent card grid |
| `/agents/create` | `AgentCreatePage` | New agent form |
| `/agents/:id` | `AgentDetailPage` | Edit + test agent |
| `/flows` | `FlowsPage` | Flow list |
| `/flows/create` | `FlowCreatePage` | Flow builder |
| `/flows/:id` | `FlowDetailPage` | Edit flow + run history |

---

## AgentsPage
- Card grid: avatar | name | model | enabled tools | description preview
- New Agent button
- Search/filter

## AgentCreatePage / AgentDetailPage
Split layout: form left, test panel right.

**Form sections:**

**Identity**
- Name, description
- Color picker (for visual identification in flows)
- Emoji / icon

**Model**
- Model picker dropdown (local Ollama models)
- "Think mode" toggle. Helper: "For models that support `<think>` tags (Qwen3.5, DeepSeek R1). Enables extended internal reasoning before responding. Adds latency but improves complex task quality."

**System Prompt**
- Large textarea
- "Use persona" button — imports system prompt from a boolab persona
- Character count
- Variable inserter: `{{date}}`, `{{time}}`, `{{user_input}}` chips

**Tools**
Toggle list of available tools:
- Each tool shows: icon | name | description | config button (if configurable)
- `rag_lookup` config: picker to select which RAG config
- `http_request` config: URL + method + headers
- `web_search` config: max results slider

**Inference Parameters**
- Temperature, Top-P, Top-K, Max Tokens, Context Window
- All sliders with same explainers as Phase 1

**Test Panel (right side)**
- Message input
- Stream checkbox (see tokens appear in real time)
- "Run Agent" button
- Response area with `<think>` blocks collapsible if present
- Token count + elapsed time
- Tool calls shown inline as collapsible cards

---

## FlowsPage
- List view: name | step count | trigger | last run | status
- New Flow button
- Enable/disable toggle per flow

## FlowCreatePage / FlowDetailPage

### Flow Builder (visual step editor)
Not a full canvas — a vertical step list with drag-to-reorder:

```
┌─────────────────────────────────────────────────┐
│ Flow: Research Summary                           │
├─────────────────────────────────────────────────┤
│ [Step 1] Input                                  │
│  Type: User message                             │
│  Output: "query"                                │
├──────────────────────┬──────────────────────────┤
│       ↓              │                          │
├─────────────────────────────────────────────────┤
│ [Step 2] Agent Call  [⋮] [↑] [↓] [×]           │
│  Agent: ResearchAgent                           │
│  Input from: Step 1 "query"                     │
│  Output to: "search_result"                     │
├─────────────────────────────────────────────────┤
│       ↓                                         │
├─────────────────────────────────────────────────┤
│ [Step 3] Agent Call  [⋮] [↑] [↓] [×]           │
│  Agent: SummaryAgent                            │
│  Input from: Step 2 "search_result"             │
│  Prompt template: "Summarize this: {{input}}"   │
│  Output to: "summary"                           │
├─────────────────────────────────────────────────┤
│       ↓                                         │
├─────────────────────────────────────────────────┤
│ [Step 4] Output                                 │
│  Format: Markdown                               │
│  Return: Step 3 "summary"                       │
└─────────────────────────────────────────────────┘
            [+ Add Step]
```

**Step types:**
- `input` — takes user message as starting input
- `agent_call` — runs a saved agent
- `tool_call` — runs a tool directly (without an agent)
- `condition` — if/else branch based on previous output
- `output` — formats and returns final result
- `n8n_webhook` — POSTs result to an n8n webhook URL

**Each step card shows:**
- Step type icon + label
- Configured agent/tool name
- Input source (which previous step's output)
- Reorder handles + delete button
- Expand to edit

### Trigger Settings
- Manual (default) — run button
- Schedule — cron input with human-readable preview
- Webhook — generates a unique URL: `POST https://ai.boogaardmusic.com/api/flows/{id}/webhook/{token}`
- n8n integration — shows how to call from n8n HTTP Request node

### Run Panel
Below the builder:
- "Run Flow" button (manual trigger)
- Input text area for the initial message
- Execution trace: step-by-step output in real time (SSE streaming)
- Each step shows: status | elapsed time | input | output
- Full run log expandable per step

### Run History
- Last 20 executions table: timestamp | trigger | status | duration
- Click to expand: full step-by-step trace

---

## n8n Integration
OllamaCtl flows can be triggered from n8n (b2b at `/opt/b2b/`):
- Flow generates a webhook token on creation
- n8n HTTP Request node POSTs to `https://ai.boogaardmusic.com/api/flows/{id}/webhook/{token}`
- Body: `{"input": "..."}`
- OllamaCtl runs the flow and returns the final output in the response
- Alternatively: n8n polls `GET /api/flows/{id}/runs` for async results

---

## Cursor Context Files for Phase 6
- `CONTEXT.md`
- `DB_SCHEMA.md`
- `UI_DESIGN.md`
- `PHASE_1_MODEL_MANAGEMENT.md`
- `PHASE_2_PERSONA_SYNC.md`
- `PHASE_5_RAG_CONTROL.md`

---

## Estimated Cursor Sessions
3 sessions: Session 1 = agents CRUD + test panel. Session 2 = flow builder UI. Session 3 = flow execution engine + n8n integration.
