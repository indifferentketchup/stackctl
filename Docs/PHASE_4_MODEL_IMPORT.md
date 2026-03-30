# OllamaCtl — Phase 4: Model Import
Last updated: March 2026

---

## Goal
UI for importing models into Ollama from GGUF files, safetensors, and Hugging Face repos. Handles the Modelfile generation, quantization selection, and the double-FROM mmproj problem that's caused issues with HF multimodal models.

---

## Import Methods

### Method 1: Pull from HF (already in Phase 1 pull UI)
Enhanced in Phase 4 with:
- Auto-detect if model is multimodal (has mmproj blob)
- Warn user and offer to create clean single-FROM Modelfile
- Quant picker: shows available quant files in HF repo before pulling

### Method 2: GGUF from local path
- File path on sam-desktop (e.g. `D:\models\mymodel.Q4_K_M.gguf`)
- OllamaCtl sends path to backend → backend creates Modelfile with `FROM <path>`
- Model name input
- Template picker (same as Phase 1 guided form)
- Parameter sliders

### Method 3: Safetensors / HF format
- Requires llama.cpp `convert_hf_to_gguf.py` to be available on sam-desktop
- OllamaCtl shows instructions + manual steps (conversion must happen on Windows)
- After conversion: use Method 2

### Method 4: From Modelfile (manual)
- Raw Modelfile textarea
- Model name input
- Submits directly to `POST /api/models/create`

---

## The Double-FROM Problem
Documented issue: when pulling HF multimodal GGUFs, Ollama auto-generates a Modelfile with two `FROM` lines (text GGUF + mmproj vision projector). This causes a 500 error on load.

**Fix flow:**
1. User pulls `hf.co/User/Model:tag`
2. After pull completes, backend calls `POST /api/show` to get the generated Modelfile
3. Backend detects double `FROM` lines
4. Frontend shows warning: "This model has a vision projector (mmproj) blob. Ollama tried to load it as a multimodal model, which may cause errors."
5. Offers: "Create a text-only version" button
6. Auto-generates clean single-FROM Modelfile using only the larger blob (text model)
7. Creates new model with clean name (e.g. `mymodel:text-only`)

**Detection logic:**
```python
def has_double_from(modelfile: str) -> bool:
    from_lines = [l for l in modelfile.split('\n') if l.strip().startswith('FROM ')]
    return len(from_lines) > 1

def get_text_blob(modelfile: str) -> str:
    """Returns the larger FROM blob (text model, not mmproj)."""
    from_lines = [l.strip() for l in modelfile.split('\n') if l.strip().startswith('FROM ')]
    # mmproj blobs are typically ~900MB, text blobs are 5GB+
    # Return the one that's NOT the mmproj (heuristic: larger path)
    # In practice, text GGUF is always listed first
    return from_lines[0].replace('FROM ', '').strip()
```

---

## Backend Routes

### `POST /api/import/gguf`
Body: `{"model_name": "mymodel:latest", "gguf_path": "D:\\models\\file.gguf", "template": "chatml", "parameters": {...}}`
Generates Modelfile and calls Ollama `/api/create`.

### `POST /api/import/fix-multimodal`
Body: `{"source_model": "hf.co/User/Model:tag", "new_name": "mymodel:text-only"}`
Fetches Modelfile from pulled model, extracts first FROM blob, creates clean model.

### `GET /api/import/jobs`
Returns all import jobs from `import_jobs` table.

### `GET /api/import/jobs/{id}`
Returns specific import job status.

---

## Frontend Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/models/import` | `ImportPage` | Import method selector + forms |
| `/models/import/jobs` | `ImportJobsPage` | Import history |

---

## ImportPage

### Method selector
Four tabs / cards at top: **HF Pull** | **GGUF File** | **Manual Modelfile** | **Import History**

### HF Pull tab (enhanced from Phase 1)
- Model name input (same as pull page)
- "Check quants" button — fetches HF repo file list and shows available GGUF quant options as radio buttons
- After pull: auto-check for double FROM, show fix button if detected

### GGUF File tab
```
Windows file path on sam-desktop:
[D:\ollama\models\blobs\sha256-...              ]

Or paste blob hash:
[sha256-abc123...                                ]

Model name: [mymodel:latest                       ]

Template: [ChatML ▾]    Stop tokens: [<|im_end|> ×] [+]

Parameters:
  Temperature  [——●————] 0.6
  Top-P        [————●———] 0.95
  Top-K        [——●————] 20
  Repeat penalty [————●] 1.0
  Stop tokens: auto-populated from template

[Preview Modelfile]  [Create Model]
```

Modelfile preview expands below the form, showing exactly what will be sent to Ollama.

### Manual Modelfile tab
- Model name input
- Modelfile textarea (syntax highlighted)
- "Validate" button — checks syntax before submit
- "Load from existing model" dropdown — loads any existing model's Modelfile for editing
- Submit button

### Double-FROM Fix banner
Shown after any pull that results in a double-FROM Modelfile:
```
⚠️  Multimodal conflict detected
This model was pulled with a vision projector (mmproj) blob. 
Ollama may fail to load it.

Text blob: sha256-8fbbc7b04... (5.6 GB)
Vision blob: sha256-3b18f4e... (921 MB)

[Create text-only version →]   [Ignore]
```
"Create text-only version" opens a modal with model name input pre-filled as `{original_name}:text` and submits to `/api/import/fix-multimodal`.

---

## Quantization Reference Card
Shown on the GGUF import tab as a collapsible reference:

"Choosing a quantization: If the model filename contains `Q4_K_M`, it's already quantized at 4-bit medium. You don't re-quantize at import — the GGUF file IS the quantized model. Pick the GGUF file that matches your VRAM."

Links to the Hardware → Quantization page for the full VRAM calculator.

---

## Cursor Context Files for Phase 4
- `CONTEXT.md`
- `DB_SCHEMA.md`
- `UI_DESIGN.md`
- `PHASE_1_MODEL_MANAGEMENT.md`
- `PHASE_3_GPU_QUANTIZATION.md`

---

## Estimated Cursor Sessions
1 session.
