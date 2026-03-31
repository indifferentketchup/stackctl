# Cursor Prompt — ollamactl: SSH-based Modelfile Apply to Ollama

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `backend/main.py`
- `backend/routers/ollama.py`
- `backend/db.py`
- `src/pages/ModelfilePage.jsx`
- `src/App.jsx`

Do not touch any file not explicitly listed below.

---

## Context
ollamactl needs to apply Modelfile changes directly to Ollama on sam-desktop (`100.101.41.16`). It does this by SSHing into sam-desktop, writing a temp Modelfile, and running `ollama create`. The SSH key is at `/opt/ollamactl/ssh/id_ed25519` inside the backend container (mounted as a volume). The SSH user is `samki`, host is `100.101.41.16`.

Ollama on sam-desktop is an NSSM service. The `ollama` binary is at `D:\ollama\ollama.exe` but is also on PATH so `ollama` works directly in SSH sessions.

---

## Backend changes

### New dependency
Add to `backend/requirements.txt`:
```
asyncssh==2.14.2
```

### `backend/routers/modelfile_apply.py` — NEW FILE

```python
"""
SSH into sam-desktop and apply a Modelfile via `ollama create`.
"""
```

#### Endpoints

**`POST /api/models/apply`**

Body:
```json
{
  "name": "model-name",
  "modelfile": "FROM ...\nPARAMETER temperature 0.6\n...",
  "overwrite": true
}
```

- Requires `require_admin`
- SSHes into sam-desktop using asyncssh
  - Host: `SAMDESKTOP_HOST` env var (default `100.101.41.16`)
  - User: `SAMDESKTOP_USER` env var (default `samki`)
  - Key: `SAMDESKTOP_SSH_KEY` env var (default `/opt/ollamactl/ssh/id_ed25519`)
- Steps executed over SSH:
  1. Write the Modelfile to a temp path on sam-desktop:
     ```
     $env:TEMP\ollamactl_modelfile_{uuid}.txt
     ```
     Use asyncssh `sftp` to write the file.
  2. If `overwrite=true` and model already exists: run `ollama rm {name}` first
  3. Run `ollama create {name} -f $env:TEMP\ollamactl_modelfile_{uuid}.txt`
  4. Delete the temp file
- Returns SSE stream of progress:
  - `{ type: "log", line: "..." }` for each stdout/stderr line
  - `{ type: "done", success: true }` on completion
  - `{ type: "error", message: "..." }` on failure
- Streams output in real time — do not buffer

**`POST /api/models/pull-and-create`**

Body:
```json
{
  "hf_ref": "hf.co/Jackrong/Qwen3.5-9B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF:Q8_0",
  "name": "qwen35-9b-claude-q8",
  "template": "chatml",
  "parameters": {
    "temperature": 0.6,
    "top_p": 0.95,
    "top_k": 20,
    "repeat_penalty": 1.0,
    "stop": ["<|im_start|>", "<|im_end|>", "<|endoftext|>"]
  }
}
```

- Requires `require_admin`
- Step 1: Pull the HF model via existing `/api/ollama/pull` SSE endpoint logic — reuse the `_stream_ollama_pull` function
- Step 2: After pull completes, get the modelfile via `POST {OLLAMA_URL}/api/show` with `{"name": hf_ref}`
- Step 3: Extract only the FIRST `FROM` line (the large blob, not mmproj) — detect mmproj by checking if the blob size is < 2GB (mmproj blobs are typically 500MB-1GB, text model blobs are always larger). If both FROM lines are present, keep only the larger blob's FROM.
- Step 4: Build a clean Modelfile with the extracted FROM + supplied template + parameters
- Step 5: Call the same SSH apply logic as `/api/models/apply`
- Step 6: Delete the HF original via `DELETE {OLLAMA_URL}/api/delete` with `{"name": hf_ref}`
- Returns SSE stream of all steps with progress

**`GET /api/models/ssh-status`**
- Tests SSH connection to sam-desktop
- Returns `{ connected: bool, host: str, user: str, error: str | null }`
- No auth required (used for connection status indicator)

Register router in `backend/main.py` with prefix `/api/models`.

### `.env` additions
```
SAMDESKTOP_HOST=100.101.41.16
SAMDESKTOP_USER=samki
SAMDESKTOP_SSH_KEY=/opt/ollamactl/ssh/id_ed25519
```

### `docker-compose.yml`
Mount the SSH key directory:
```yaml
volumes:
  - /opt/ollamactl/ssh:/opt/ollamactl/ssh:ro
  - /docker/ollamactl:/data
```

---

## Template presets

Define in `backend/templates.py` — NEW FILE:

```python
TEMPLATES = {
    "chatml": '''{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{- range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}<|im_start|>assistant
''',
    "llama3": '''{{ if .System }}<|start_header_id|>system<|end_header_id|>
{{ .System }}<|eot_id|>{{ end }}{{ if .Prompt }}<|start_header_id|>user<|end_header_id|>
{{ .Prompt }}<|eot_id|>{{ end }}<|start_header_id|>assistant<|end_header_id|>
''',
    "mistral": '''{{ if .System }}[INST] {{ .System }}
{{ end }}{{ if .Prompt }}[INST] {{ .Prompt }} [/INST]{{ end }}
''',
}

DEFAULT_STOP_TOKENS = {
    "chatml": ["<|im_start|>", "<|im_end|>", "<|endoftext|>"],
    "llama3": ["<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>"],
    "mistral": ["[INST]", "[/INST]"],
}
```

---

## Frontend changes

### `src/pages/ModelfilePage.jsx`

Add an "Apply to Ollama" button in the bottom action bar, next to the existing save/create button.

**Behavior:**

For **existing model edit mode** (URL param `:name` present):
- Button label: "Apply to Ollama"
- Clicking it calls `POST /api/models/apply` with:
  - `name`: current model name
  - `modelfile`: current raw modelfile content
  - `overwrite`: true
- Opens a slide-in terminal panel showing SSE log stream

For **create mode** (no URL param):
- Same as existing "Create Model" button but routes through SSH
- After name is entered, calls `POST /api/models/apply`

**Terminal panel** (slide in from bottom, full width):
- Dark background (`#0a0a0a`), monospace font
- Each SSE `log` line appended as a new line
- Green text for success lines, red for errors, white for normal output
- Shows spinner while running
- "Done ✓" or "Failed ✗" at end
- "Close" button

### `src/pages/ModelsPage.jsx`

Add a **"Pull from HuggingFace"** button in the page header alongside existing "Pull Model" and "Create Model".

Opens a new drawer/modal:

**Pull from HuggingFace drawer:**

Fields:
- HF reference: text input, placeholder `hf.co/user/repo:Q4_K_M`
  - Helper: "Include the quant tag e.g. :Q4_K_M — omitting it pulls the default which may include a vision projector"
- Model name: text input (what to call it in Ollama)
  - Auto-suggests a clean name from the HF ref (strips `hf.co/`, replaces `/` with `-`, lowercases)
- Template: dropdown — ChatML | Llama3 | Mistral
  - Default: ChatML (works for most modern models)
- Parameters section (collapsible, defaults pre-filled):
  - temperature, top_p, top_k, repeat_penalty, num_ctx
  - Stop tokens: pre-filled based on selected template, editable

"Pull & Create" button → calls `POST /api/models/pull-and-create` → opens terminal panel showing full progress (pull + create + cleanup)

### `src/components/SshStatusIndicator.jsx` — NEW FILE

Small indicator shown in the page header of ModelsPage and ModelfilePage:
- Green dot + "sam-desktop connected" 
- Red dot + "sam-desktop unreachable" 
- Polls `/api/models/ssh-status` every 30 seconds
- Tooltip shows host + user on hover

---

## Constraints
- SSH key file must be readable by the backend container — mount as read-only volume
- Never log the SSH key path or contents
- The mmproj detection (step 3 of pull-and-create) must use blob file size from Ollama's show response, not filename heuristics — check `details.size` or the FROM line's corresponding blob size
- If SSH connection fails, return a clear error immediately — do not retry
- All SSH commands run as `samki` on sam-desktop — `ollama` must be on PATH for that user
- Windows temp path in SSH context: use `$env:TEMP` — this resolves correctly in PowerShell over SSH
- The terminal panel must scroll to bottom automatically as new lines arrive
- Mobile: terminal panel is full-screen overlay
- Do not change any existing pull/delete endpoints
- Rebuild required after adding asyncssh: `docker compose up --build -d ollamactl-api`
