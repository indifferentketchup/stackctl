# Cursor Prompt — ollamactl Phase 4: Model Import + Quantization

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `src/App.jsx`
- `src/pages/ModelfilePage.jsx` (Phase 2 output)
- `backend/routers/ollama.py`

Do not touch any file not explicitly listed below.

---

## Context
Model import means creating a new Ollama model from a local file path (GGUF or Safetensors directory) or from HuggingFace. Quantization means using `ollama create --quantize <level>` to reduce a full-precision model to a smaller quant during import. All file paths refer to paths on **sam-desktop** (the Windows machine running Ollama at `100.101.41.16`), not on the homelab server.

---

## Backend additions (`backend/routers/ollama.py`)

### New endpoint: `POST /api/ollama/create-quantized`

Body:
```json
{
  "name": "mymodel",
  "modelfile": "FROM /path/to/model",
  "quantize": "q4_K_M"
}
```

- Supported quantize values: `q8_0`, `q4_K_S`, `q4_K_M`
- Calls Ollama's `POST /api/create` with `{"name": name, "modelfile": modelfile, "quantize": quantize}`
- Returns SSE stream of progress events (same pattern as existing `/api/ollama/create`)
- If `quantize` is null/omitted, behaves identically to existing `/api/ollama/create`
- Requires `require_admin`

### New endpoint: `GET /api/ollama/hf-files`

Query param: `repo` (e.g. `Jackrong/Qwen3.5-9B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF`)

- Calls `https://huggingface.co/api/models/{repo}` to get the file list
- Returns filtered list of `.gguf` files with name and size
- Also returns model card metadata: architecture, parameter size, license
- Handles 404 gracefully (returns `{ error: "repo not found" }`)
- No auth required (public HF API)

---

## Frontend

### `src/pages/ImportPage.jsx` — NEW FILE

**Header:** "Import Model" + back button

**Three import method tabs:**

---

#### Tab 1: GGUF File

**Path input:**
- Text field: "Path to GGUF file on sam-desktop"
- Helper: "Enter the full Windows path, e.g. `D:\ollama models\blobs\sha256-abc123...` or `D:\mymodels\llama.gguf`"
- Note banner: "The path must be accessible from Ollama running on sam-desktop (100.101.41.16). Docker paths on homelab will not work."

**Template selector** (same presets as ModelfilePage Phase 2):
- Auto-detect | ChatML | Llama 3 | Mistral | Raw/Custom

**mmproj warning detector:**
- After path is entered, check if it looks like a vision projector blob (heuristic: filename contains "mmproj" or "vision")
- If detected: amber warning "This looks like a vision projector blob. Import only the text GGUF, not the mmproj file."

**Optional system prompt:** collapsible textarea

**Quantization section** (collapsible, off by default):
- Toggle: "Quantize during import"
- When enabled, shows radio buttons:
  - `q4_K_M` — **Recommended** — ~5.6GB for 9B. Best balance of quality and size.
  - `q4_K_S` — Smaller — ~5.3GB for 9B. Slightly lower quality.
  - `q8_0` — High quality — ~9.5GB for 9B. Near full quality, larger file.
- Note: "Only works on F16/F32 source models. Already-quantized GGUFs cannot be re-quantized."

**Model name input + Import button** → SSE progress

---

#### Tab 2: Safetensors Directory

**Path input:**
- Text field: "Path to Safetensors directory on sam-desktop"
- Helper: "Directory must contain model weights in .safetensors format"

**Supported architectures info box:**
```
✓ Llama (1, 2, 3, 3.1, 3.2)
✓ Mistral (1, 2, Mixtral)
✓ Gemma (1, 2)
✓ Phi3
```

**LoRA adapter toggle:**
- Checkbox: "This is a LoRA adapter (not a full model)"
- When checked: shows "Base model" dropdown (local models list) — required
- Helper: "Adapters must match the base model's architecture exactly."

**Quantization section** (same as GGUF tab — Safetensors can be quantized):
- Same radio buttons + same note

**Model name input + Import button** → SSE progress

---

#### Tab 3: HuggingFace

**Repo input:**
- Text field: "HuggingFace repo (e.g. `Jackrong/Qwen3.5-9B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF`)"
- "Look up" button → calls `/api/ollama/hf-files`

**Repo info panel** (shown after lookup):
- Model card metadata: architecture, parameter size, license
- GGUF files table: filename | size | quant level (parsed from filename)
  - Quant level color coding: Q4_K_M = green (recommended), Q8_0 = blue, Q2/Q3 = amber
  - "Select" button per file → fills the pull name field

**Pull name field:**
- Auto-filled as `hf.co/{repo}:{filename_without_extension}` when a file is selected
- Editable
- mmproj warning: if selected file contains "mmproj", show amber warning box:
  "⚠️ This is a vision projector file. Pulling it alongside the text model will cause a 500 error in Ollama. Select the text-only GGUF instead."

**Double FROM explanation box** (always visible on this tab):
```
ℹ️ HuggingFace GGUF models tagged as multimodal (image-text-to-text) 
will cause Ollama to pull a vision projector alongside the text model, 
resulting in a 500 error. If this happens, use the Modelfile Editor 
to create the model manually with only the text blob's FROM line.
```

**Pull button** → uses existing pull flow (SSE progress, same as ModelsPage pull drawer)

Note: HuggingFace imports do NOT support the quantize flag — the model is already quantized.

---

### Add to sidebar
Enable the Import nav item or add under Models:
```
Models
  ├── All Models    → /models
  ├── Import        → /import
  └── Create        → /models/create
```

---

## Constraints
- All file paths are on sam-desktop — make this extremely clear in the UI
- The quantize feature requires a fresh F16/F32 model — add inline validation that warns if the FROM path appears to already be quantized (contains Q4, Q8, etc. in the name)
- HF repo lookup calls an external API — add loading state and error handling
- Mobile: tabs collapse to dropdown selector on small screens
- Do not change ModelfilePage — import creates its own simplified version of the FROM + template + params flow
