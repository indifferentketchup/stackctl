# Cursor Prompt — ollamactl: SSH-based GPU & NSSM Management

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `backend/main.py`
- `backend/routers/modelfile_apply.py` (SSH pattern to follow)
- `backend/routers/gpu.py`
- `backend/db.py`
- `src/pages/GpuPage.jsx`

Do not touch any file not explicitly listed below.

---

## Context
All GPU and NSSM configuration on sam-desktop is now applied via SSH. The existing `GpuPage.jsx` shows a "copy PowerShell commands" workflow — replace this entirely with live SSH execution. The SSH pattern is already established in `modelfile_apply.py` — follow it exactly including `known_hosts=None`.

sam-desktop specifics:
- Tailscale IP: `100.101.41.16`
- SSH user: `samki`
- SSH key: `SAMDESKTOP_SSH_KEY` env var (default `/opt/ollamactl/ssh/id_ed25519`)
- NSSM binary: `C:\Tools\nssm.exe`
- Ollama service name: `OllamaService`
- Ollama binary: `D:\ollama\ollama.exe`

---

## Backend changes (`backend/routers/gpu.py`)

Replace the existing static command-generator endpoints with live SSH execution.

### Keep existing:
- `GET /api/gpu/status` — unchanged
- `GET /api/gpu/config` — unchanged (reads SQLite)
- `PUT /api/gpu/config` — unchanged (writes SQLite)

### Replace/add:

**`GET /api/gpu/nssm-env`**
- SSHes into sam-desktop
- Runs: `C:\Tools\nssm.exe get OllamaService AppEnvironmentExtra`
- Parses the output into a dict of env var key/value pairs
- Returns `{ env: { "CUDA_VISIBLE_DEVICES": "0,1", "OLLAMA_KEEP_ALIVE": "30m", ... }, raw: "..." }`
- If NSSM not found or service not found: returns `{ env: {}, error: "..." }`
- Requires `require_admin`

**`POST /api/gpu/nssm-env`**
- Body: `{ env: { "CUDA_VISIBLE_DEVICES": "0,1", "OLLAMA_KEEP_ALIVE": "30m", ... } }`
- SSHes into sam-desktop
- Builds the NSSM set command:
  ```
  C:\Tools\nssm.exe set OllamaService AppEnvironmentExtra "KEY1=VAL1" "KEY2=VAL2" ...
  ```
- Runs it over SSH
- Returns SSE stream:
  - `{ type: "log", line: "..." }` per stdout/stderr line
  - `{ type: "done", success: true }` on completion
  - `{ type: "error", message: "..." }` on failure
- Requires `require_admin`

**`POST /api/gpu/restart-ollama`**
- SSHes into sam-desktop
- Runs: `C:\Tools\nssm.exe restart OllamaService`
- Streams output as SSE same as above
- After restart, waits up to 15 seconds for Ollama API to respond at `{OLLAMA_URL}/api/version`
- Returns `{ type: "done", success: true, ollama_version: "..." }` when back up
- Returns `{ type: "error", message: "Ollama did not come back up within 15 seconds" }` on timeout
- Requires `require_admin`

**`POST /api/gpu/stop-ollama`**
- SSHes into sam-desktop
- Runs: `C:\Tools\nssm.exe stop OllamaService`
- Streams output as SSE
- Requires `require_admin`

**`POST /api/gpu/start-ollama`**
- SSHes into sam-desktop
- Runs: `C:\Tools\nssm.exe start OllamaService`
- Streams output as SSE
- Requires `require_admin`

**`GET /api/gpu/ollama-service-status`**
- SSHes into sam-desktop
- Runs: `C:\Tools\nssm.exe status OllamaService`
- Returns `{ status: "Running" | "Stopped" | "Unknown", raw: "..." }`
- No auth required (used for status indicator)

---

## Frontend changes (`src/pages/GpuPage.jsx`)

Rewrite the page to use live SSH execution. Remove all "copy PowerShell" command generation.

---

### Section 1: Service Status (top of page)

Live status card, auto-refreshes every 15 seconds via `/api/gpu/ollama-service-status` and `/api/gpu/status`:

```
┌─────────────────────────────────────────────┐
│  OllamaService          ● Running            │
│  v0.6.8 on sam-desktop                       │
│  RTX 5090 · 2 models loaded · 18.5 GB VRAM  │
│                                              │
│  [Stop]  [Restart]  [Start]                  │
└─────────────────────────────────────────────┘
```

- Stop/Restart/Start buttons each open the terminal panel with SSE stream
- Restart button: disabled while Ollama is stopped
- Start button: only shown when stopped
- Stop button: only shown when running
- After restart completes, auto-refreshes status

---

### Section 2: Environment Variables

On page load, fetches current values from `/api/gpu/nssm-env` and populates the form.

Same variables as before, but now live-loaded from NSSM:

| Variable | Input type | Explanation |
|---|---|---|
| `CUDA_VISIBLE_DEVICES` | text | Which GPUs Ollama uses. `0` = RTX 5090 only. `0,1` = both. |
| `OLLAMA_GPU_LAYERS` | number (empty = auto) | Layers to offload to GPU. Empty = auto-detect. |
| `OLLAMA_MAX_LOADED_MODELS` | number 1–8 | Max models in VRAM simultaneously. |
| `OLLAMA_KEEP_ALIVE` | text | VRAM retention after last use. `30m`, `1h`, `0`, `-1`. |
| `OLLAMA_FLASH_ATTENTION` | toggle (0/1) | Reduces VRAM with minimal quality loss. |
| `OLLAMA_KV_CACHE_TYPE` | select (f16/q8_0/q4_0) | KV cache quantization. See explanation below. |
| `OLLAMA_NUM_PARALLEL` | number (empty = auto) | Parallel request slots. |
| `OLLAMA_HOST` | text | Bind address. Default `0.0.0.0:11434`. |

Each field shows its current live value loaded from NSSM.

**KV Cache explanation card** (inline, not collapsible):
```
f16    Full precision. Best quality. ~2GB per 8K ctx on 9B model.
q8_0   ★ Recommended. ~50% less VRAM. Minimal quality loss.
q4_0   Maximum savings. ~75% less VRAM. Noticeable on long context.
```

**"Apply Changes" button:**
- Collects all field values
- Calls `POST /api/gpu/nssm-env` → streams into terminal panel
- After apply completes, shows: "Restart Ollama to apply changes" with a Restart button
- Does NOT auto-restart — user must confirm

**"Apply & Restart" button:**
- Calls `POST /api/gpu/nssm-env` first
- On completion calls `POST /api/gpu/restart-ollama`
- Both stream into the same terminal panel sequentially

---

### Section 3: GPU Presets

Three preset cards — clicking one fills the env var form above (does not apply immediately):

**Single GPU (RTX 5090 only)**
```
CUDA_VISIBLE_DEVICES=0
OLLAMA_MAX_LOADED_MODELS=1
```

**Dual GPU Auto-Split**
```
CUDA_VISIBLE_DEVICES=0,1
OLLAMA_MAX_LOADED_MODELS=1
```

**Two Models Simultaneously**
```
CUDA_VISIBLE_DEVICES=0,1
OLLAMA_MAX_LOADED_MODELS=2
OLLAMA_KEEP_ALIVE=30m
```

Each card: title, description, "Load Preset" button → fills form fields, does not apply.

---

### Section 4: Terminal Panel

Reuse `ApplyTerminalPanel.jsx` from `modelfile_apply.py` implementation — same component, same SSE streaming pattern.

---

### Section 5: Hardware Reference (static, collapsible)

```
sam-desktop
├── CPU: Windows 11
├── GPU 0: RTX 5090 — 32GB VRAM  
├── GPU 1: RTX 4080 Super — 16GB VRAM (if installed)
├── Ollama: NSSM service "OllamaService"
├── Binary: D:\ollama\ollama.exe
└── NSSM: C:\Tools\nssm.exe
```

---

## `src/api/gpu.js` — update

Add API wrappers for all new endpoints following same pattern as `src/api/models.js`. Include:
- `fetchNssmEnv()`
- `applyNssmEnv(env)` — returns SSE stream
- `restartOllama()` — returns SSE stream
- `stopOllama()` — returns SSE stream
- `startOllama()` — returns SSE stream
- `fetchOllamaServiceStatus()`

---

## Constraints
- Follow the exact SSH connection pattern from `modelfile_apply.py` including `known_hosts=None`
- All SSH commands use PowerShell syntax — wrap in `powershell -Command "..."` if needed for env var handling
- NSSM `AppEnvironmentExtra` format: space-separated quoted strings `"KEY=VALUE" "KEY2=VALUE2"`
- Never auto-restart without user confirmation except when user clicks "Apply & Restart"
- Terminal panel must auto-scroll and show Done ✓ / Failed ✗
- Remove all PowerShell copy-paste generation code from the old GpuPage — it is fully replaced
- Mobile: all cards stack, terminal panel is full-screen overlay
- Do not change `gpu_config` SQLite table or `GET/PUT /api/gpu/config` endpoints — they still store the desired config as a record
