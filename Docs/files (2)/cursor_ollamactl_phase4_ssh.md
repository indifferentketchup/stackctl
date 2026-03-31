# Cursor Prompt — ollamactl Phase 4: Model Import + Quantization (SSH-enabled)

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `backend/main.py`
- `backend/routers/modelfile_apply.py` — SSH pattern, follow exactly
- `backend/routers/ollama.py`
- `src/pages/ModelfilePage.jsx`
- `src/components/ApplyTerminalPanel.jsx`

Do not touch any file not explicitly listed below.

---

## Context
Model import means creating a new Ollama model from a file path on **sam-desktop** (GGUF or Safetensors directory) or from HuggingFace. All `ollama create`, `ollama pull`, and `ollama rm` commands execute on sam-desktop via SSH. File paths in Modelfiles refer to paths on sam-desktop's filesystem, not homelab.

SSH pattern: always `known_hosts=None`, key from `SAMDESKTOP_SSH_KEY`, host from `SAMDESKTOP_HOST`, user from `SAMDESKTOP_USER`. Follow `modelfile_apply.py` exactly.

---

## Backend additions (`backend/routers/ollama.py`)

### New endpoint: `POST /api/ollama/create-quantized`

Body:
```json
{
  "name": "mymodel",
  "modelfile": "FROM ...",
  "quantize": "q4_K_M"
}
```

- Supported quantize values: `q8_0`, `q4_K_S`, `q4_K_M`
- **SSHes into sam-desktop** using asyncssh (same pattern as `modelfile_apply.py`)
- Writes Modelfile to `%TEMP%\ollamactl_quant_{uuid}.txt` via SFTP
- Runs: `ollama create {name} --quantize {quantize} -f %TEMP%\ollamactl_quant_{uuid}.txt`
- Deletes temp file after
- Returns SSE stream of progress (same pattern as `/api/models/apply`)
- If `quantize` is null/omitted: falls back to regular `ollama create` (no quantize flag)
- Requires `require_admin`

### New endpoint: `GET /api/ollama/hf-files`

Query param: `repo` (e.g. `Jackrong/Qwen3.5-9B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF`)

- Calls `https://huggingface.co/api/models/{repo}`
- Returns filtered list of `.gguf` files with name and size
- Also returns metadata: architecture, parameter size, license
- Handles 404 gracefully
- No auth required (public HF API)

### New endpoint: `POST /api/ollama/verify-path`

Body: `{ path: str }`

- **SSHes into sam-desktop** using asyncssh
- Runs: `Test-Path "{path}"` via SSH
- Returns `{ exists: bool, is_file: bool, is_dir: bool, size_bytes: int | null }`
- Used to validate GGUF/Safetensors paths before import
- Requires `require_admin`

---

## Frontend

### `src/pages/ImportPage.jsx` — NEW FILE

**Header:** "Import Model" + back button
**SSH status indicator** in header — if sam-desktop unreachable, show warning and disable all import buttons

**Three import method tabs:**

---

#### Tab 1: GGUF File

**Path input:**
- Text field: "Path to GGUF file on sam-desktop"
- Helper: "Windows path on sam-desktop e.g. `D:\mymodels\llama.gguf`"
- "Verify Path" button → calls `/api/ollama/verify-path` → shows ✓ exists / ✗ not found
- mmproj warning: if filename contains "mmproj" show amber warning "This looks like a vision projector blob — import the text GGUF only"

Note banner: "File must exist on sam-desktop (100.101.41.16). Paths on ubuntu-homelab will not work."

**Template selector:** Auto-detect | ChatML | Llama3 | Mistral

**Optional system prompt:** collapsible textarea

**Quantization section** (collapsible, off by default):
- Toggle: "Quantize during import"
- Radio buttons:
  - `q4_K_M` — **Recommended** — Best balance of quality and VRAM
  - `q4_K_S` — Smaller, slightly lower quality
  - `q8_0` — High quality, larger file
- Note: "Source model must be F16/F32. Already-quantized GGUFs cannot be re-quantized."

**Model name input + "Import via SSH" button** → calls `/api/ollama/create-quantized` → opens `ApplyTerminalPanel` with SSE stream

---

#### Tab 2: Safetensors Directory

**Path input:**
- Text field: "Path to Safetensors directory on sam-desktop"
- "Verify Path" button → validates via SSH
- Helper: "Directory must contain .safetensors weight files"

**Supported architectures info box:**
```
✓ Llama (1, 2, 3, 3.1, 3.2)
✓ Mistral (1, 2, Mixtral)
✓ Gemma (1, 2)
✓ Phi3
```

**LoRA adapter toggle:**
- When checked: shows "Base model" dropdown (local models list) — required
- Changes Modelfile to use `ADAPTER` instruction instead of `FROM`

**Quantization section:** same as GGUF tab

**Model name input + "Import via SSH" button** → SSE stream in `ApplyTerminalPanel`

---

#### Tab 3: HuggingFace

**Repo input:**
- Text field: "HuggingFace repo"
- "Look up" button → calls `/api/ollama/hf-files`

**Repo info panel** (after lookup):
- Metadata: architecture, param size, license
- GGUF files table: filename | size | quant level
  - Q4_K_M = green (recommended), Q8_0 = blue, Q2/Q3 = amber
  - "Select" fills the pull name field

**Pull name field:** auto-filled as `hf.co/{repo}:{quant}`, editable

**mmproj warning** (always visible):
```
ℹ️ HF models tagged as multimodal will cause Ollama to pull a vision 
projector, resulting in a double FROM and a 500 error on load. 
Use the "Pull & Create" flow in the Models page instead — it 
automatically strips the mmproj and applies the correct template.
```

**"Pull & Create via SSH" button:**
- Calls `/api/models/pull-and-create` (from `modelfile_apply.py`)
- Opens `ApplyTerminalPanel` — shows pull progress + create + cleanup sequentially
- Template and params pre-filled from this form

---

### Add to sidebar under Models:
```
Models
  ├── All Models    → /models
  ├── Import        → /import
  └── Create        → /models/create
```

---

## Constraints
- ALL `ollama create` and `ollama pull` commands execute via SSH on sam-desktop
- "Verify Path" uses SSH — show loading state while SSH connects
- If SSH unreachable, disable Import buttons with tooltip "sam-desktop unreachable via SSH"
- Quantize flag only on F16/F32 source — add inline warning if path contains Q4/Q8/Q2 in filename
- Mobile: tabs collapse to dropdown
- Reuse `ApplyTerminalPanel` — do not create a new terminal component
- Do not change `modelfile_apply.py` endpoints
