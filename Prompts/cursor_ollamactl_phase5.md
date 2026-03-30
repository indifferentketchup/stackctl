# Cursor Prompt — ollamactl Phase 5: Multi-GPU + Quantization Config

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `src/App.jsx`
- `backend/routers/ollama.py`
- `backend/main.py`

Do not touch any file not explicitly listed below.

---

## Context
sam-desktop runs Ollama as an NSSM service on Windows. GPU config is controlled via environment variables set on the NSSM service. ollamactl cannot directly edit those env vars (no SSH to Windows), but it can:
1. Show the current effective config (read from Ollama's `/api/ps` and `/api/version`)
2. Generate the PowerShell commands needed to apply changes
3. Store the desired config in SQLite and display a "pending changes" indicator

This page is informational + command generator. It does not apply changes automatically.

---

## Backend additions

### `backend/routers/gpu.py` — NEW FILE

**`GET /api/gpu/status`**
- Calls `GET {OLLAMA_URL}/api/ps` → extracts loaded models + GPU info
- Calls `GET {OLLAMA_URL}/api/version` → Ollama version
- Returns:
```json
{
  "ollama_version": "0.6.8",
  "running_models": [...],
  "gpu_info": "extracted from ps response if available"
}
```

**`GET /api/gpu/config`**
- Reads stored GPU config from SQLite table `gpu_config` (key/value)
- Returns all stored config values

**`PUT /api/gpu/config`**
- Body: `{ key: str, value: str }`
- Upserts into `gpu_config` SQLite table
- Returns full config

All endpoints require `require_admin`.
Register in `backend/main.py` with prefix `/api/gpu`.

### SQLite schema addition (`backend/db.py`)
Add table:
```sql
CREATE TABLE IF NOT EXISTS gpu_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Frontend

### `src/pages/GpuPage.jsx` — NEW FILE

**Header:** "GPU & Inference Config"

**Section 1: Current Status**

Card showing live data from `/api/gpu/status`:
- Ollama version
- Running models count + VRAM used
- GPU info (if available from Ollama API)

Hardware info box (static, hardcoded based on known setup):
```
sam-desktop — Windows 11
├── RTX 5090 — 32GB VRAM (GPU 0)
└── RTX 4080 Super — 16GB VRAM (GPU 1, pending setup)
Ollama: NSSM service at D:\ollama\ollama.exe
```

---

**Section 2: Environment Variable Config**

For each variable, show: current stored value | input to change | explanation | example

| Variable | Input type | Default | Explanation |
|---|---|---|---|
| `CUDA_VISIBLE_DEVICES` | text | `0,1` | Controls which GPUs Ollama uses and their order. `0` = RTX 5090 only. `0,1` = both GPUs. `1,0` = 4080 Super first. |
| `OLLAMA_GPU_LAYERS` | number | (empty = auto) | Number of model layers to offload to GPU. Leave empty for auto. Useful for partial GPU offload on large models. |
| `OLLAMA_MAX_LOADED_MODELS` | number (1-8) | `1` | Max models loaded in VRAM simultaneously. Set to 2 to run 9B on 4080 Super while 27B loads on 5090. |
| `OLLAMA_KEEP_ALIVE` | text | `30m` | How long a model stays in VRAM after last use. Formats: `30m`, `1h`, `0` (unload immediately), `-1` (never unload). |
| `OLLAMA_FLASH_ATTENTION` | toggle | off | Reduces VRAM usage with minimal quality impact. Recommended: on. |
| `OLLAMA_KV_CACHE_TYPE` | select | `f16` | KV cache quantization. See explanation below. |

**KV Cache Type selector with full explanation card:**

```
f16 (default)
  Full precision KV cache. Best quality. 
  Uses 2 bytes per token per layer.
  
q8_0 — Recommended
  8-bit quantized KV cache.
  ~50% memory reduction vs f16.
  Minimal quality loss. Good for most use cases.
  
q4_0
  4-bit quantized KV cache.
  ~75% memory reduction vs f16.
  Noticeable quality reduction on long contexts.
  Best for maximum context length on limited VRAM.
```

Show VRAM impact estimate next to each option based on a 9B model example:
- f16: ~2GB for 8K context
- q8_0: ~1GB for 8K context  
- q4_0: ~500MB for 8K context

---

**Section 3: Multi-GPU Split Strategy**

Explanatory cards for common configurations with your hardware:

**Configuration A: Single GPU (current)**
```
CUDA_VISIBLE_DEVICES=0
OLLAMA_MAX_LOADED_MODELS=1
```
Best for: Large models (27B+). All VRAM on RTX 5090.

**Configuration B: Dual GPU Auto-Split**
```
CUDA_VISIBLE_DEVICES=0,1
OLLAMA_MAX_LOADED_MODELS=1
```
Best for: Very large models split across both GPUs.
Ollama automatically splits layers between GPUs.

**Configuration C: Two Models Simultaneously**
```
CUDA_VISIBLE_DEVICES=0,1
OLLAMA_MAX_LOADED_MODELS=2
```
Best for: Running 9B on 4080 Super + 27B on 5090 at the same time.

Each config card has an "Apply" button → updates stored config values for all vars in that config.

---

**Section 4: Apply Changes**

This section generates the PowerShell commands to apply the stored config to the NSSM service on sam-desktop.

Shows a code block with the generated commands:
```powershell
# Apply Ollama NSSM environment variables
# Run these commands in PowerShell on sam-desktop (100.101.41.16)

C:\Tools\nssm set OllamaService AppEnvironmentExtra `
  "CUDA_VISIBLE_DEVICES=0,1" `
  "OLLAMA_MAX_LOADED_MODELS=2" `
  "OLLAMA_KEEP_ALIVE=30m" `
  "OLLAMA_FLASH_ATTENTION=1" `
  "OLLAMA_KV_CACHE_TYPE=q8_0"

# Restart the service to apply changes
C:\Tools\nssm restart OllamaService
```

- "Copy Commands" button → copies to clipboard
- "Pending changes" badge shows if stored config differs from last-known applied config
- "Mark as Applied" button → clears pending indicator

---

## Constraints
- This page does NOT apply changes automatically — it generates commands only
- Make the "this runs on sam-desktop, not homelab" distinction extremely clear
- All config is stored in SQLite on ollamactl backend
- VRAM estimates are approximations — label them clearly as estimates
- Mobile: all cards stack vertically, code block horizontally scrollable
- Enable GPU nav item in sidebar (was stubbed in Phase 1)
