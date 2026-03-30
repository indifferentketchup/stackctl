# OllamaCtl — Phase 3: Multi-GPU + Quantization Control
Last updated: March 2026

---

## Goal
Give full control over Ollama's GPU configuration, KV cache quantization, and multi-GPU setup. Supports the upcoming 4080 Super addition to sam-desktop alongside the RTX 5090.

---

## Hardware Context
- **sam-desktop** (`100.101.41.16`): Windows, RTX 5090 (32GB VRAM), 4080 Super (16GB VRAM, coming online)
- Ollama NSSM service at `D:\ollama\ollama.exe`
- Ollama models at `D:\ollama\models`
- Ollama bound to `0.0.0.0:11434`
- Environment variables set via NSSM service configuration

---

## How Ollama Multi-GPU Works
Ollama automatically uses all available CUDA GPUs by default. Control is via env vars:
- `CUDA_VISIBLE_DEVICES=0` — use only GPU 0 (5090)
- `CUDA_VISIBLE_DEVICES=1` — use only GPU 1 (4080 Super)
- `CUDA_VISIBLE_DEVICES=0,1` — use both (model split across both)
- `OLLAMA_GPU_LAYERS` — number of layers to offload to GPU
- `OLLAMA_NUM_PARALLEL` — parallel inference requests
- `OLLAMA_MAX_LOADED_MODELS` — max models in VRAM simultaneously
- `OLLAMA_FLASH_ATTENTION=1` — enable flash attention
- `OLLAMA_KV_CACHE_TYPE=q8_0` — quantize KV cache (f16/q8_0/q4_0)

---

## Backend Routes

### `GET /api/hardware/gpus`
Fetches running model info from Ollama `/api/ps` to infer GPU usage. Also queries Ollama `/api/version` for build info. Returns detected GPU count + current env var state if available.

### `GET /api/hardware/config`
Returns active GPU config from `gpu_configs` table where `active=1`.

### `GET /api/hardware/configs`
Returns all GPU config profiles from `gpu_configs` table.

### `POST /api/hardware/configs`
Creates a new GPU config profile.

### `PUT /api/hardware/configs/{id}`
Updates a GPU config profile.

### `DELETE /api/hardware/configs/{id}`
Deletes a GPU config profile (cannot delete active config).

### `POST /api/hardware/configs/{id}/activate`
Sets `active=1` for this profile, `active=0` for all others.

### `GET /api/hardware/configs/{id}/env-block`
Generates the Windows environment variable block for this config. Returns:
```json
{
  "env_vars": {
    "CUDA_VISIBLE_DEVICES": "0,1",
    "OLLAMA_NUM_PARALLEL": "2",
    "OLLAMA_MAX_LOADED_MODELS": "2",
    "OLLAMA_FLASH_ATTENTION": "1",
    "OLLAMA_KV_CACHE_TYPE": "q8_0"
  },
  "nssm_commands": [
    "nssm set Ollama AppEnvironmentExtra CUDA_VISIBLE_DEVICES=0,1",
    "nssm set Ollama AppEnvironmentExtra OLLAMA_NUM_PARALLEL=2",
    "..."
  ],
  "restart_command": "nssm restart Ollama"
}
```

---

## Frontend Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/hardware` | `HardwarePage` | GPU status + config profiles |
| `/hardware/quantization` | `QuantizationPage` | KV cache + quant explainer |

---

## HardwarePage

### GPU Status Section
- Detected GPU cards (from Ollama /api/ps inference):
  - GPU name (if detectable)
  - Currently loaded models + layer distribution
  - VRAM used / total (if available)
- "Multi-GPU detected" banner if 2+ GPUs active

### Config Profiles Section
- List of saved profiles with active indicator
- Each profile card shows: name | GPUs | KV cache type | Flash attn | Max loaded
- "Activate" button per profile
- Edit/Delete actions

### Create/Edit Profile Form
Fields with inline explanations:

**GPU Selection**
- Checkboxes: `GPU 0 (RTX 5090 — 32GB)` | `GPU 1 (RTX 4080 Super — 16GB)`
- Helper: "Select which GPUs Ollama can use. Using both splits model layers across GPUs — great for large models that don't fit on one card."

**KV Cache Type**
- Radio buttons:
  - `F16` — Full precision. Best quality, highest VRAM usage. Default.
  - `Q8_0` — 8-bit quantized. ~50% VRAM reduction with minimal quality loss. Recommended.
  - `Q4_0` — 4-bit quantized. ~75% VRAM reduction. Noticeable quality loss on complex tasks.
- Helper: "The KV cache stores context tokens during generation. Quantizing it saves VRAM at the cost of some quality. Q8_0 is the sweet spot for most use cases."
- VRAM savings estimate shown per option based on context window size

**Flash Attention**
- Toggle. Helper: "Optimizes attention computation. Reduces VRAM usage and speeds up generation. Enable unless you hit errors."

**Max Loaded Models**
- Slider 1–4. Helper: "How many models can stay loaded in VRAM simultaneously. Higher = faster model switching but more VRAM used."

**Parallel Requests**
- Slider 1–8. Helper: "How many simultaneous inference requests Ollama handles. Higher = better throughput for multiple users, but each request gets less GPU bandwidth."

**Keep Alive**
- Text input (`30m`, `1h`, `0` = never unload, `-1` = always unload after use)
- Helper: "How long a model stays loaded after its last use. 0 = stays loaded indefinitely. -1 = unloads immediately."

### Apply Config Section
After saving a profile, shows:
- "Apply this config to Ollama" button
- Expands to show NSSM commands + restart instruction
- Copy-to-clipboard button for the full command block
- Warning: "This requires restarting the Ollama NSSM service on sam-desktop. Running models will be unloaded."

---

## QuantizationPage

### Model Quantization Explainer
Static educational content + interactive table:

**What is quantization?**
Plain-English explanation: reducing model weight precision from 32-bit floats to smaller formats to save VRAM and speed up inference, with tradeoffs in quality.

**Quantization types table:**

| Type | Bits | VRAM vs F32 | Quality Loss | Best For |
|------|------|-------------|--------------|----------|
| F32 | 32 | 100% | None | Fine-tuning only |
| F16 / BF16 | 16 | 50% | Minimal | Max quality inference |
| Q8_0 | 8 | 25% | Very low | Daily use, recommended |
| Q6_K | 6 | ~19% | Low | Good balance |
| Q5_K_M | 5 | ~16% | Low-medium | Tight VRAM |
| Q4_K_M | 4 | ~13% | Medium | Most popular |
| Q3_K_M | 3 | ~10% | Medium-high | Very tight VRAM |
| Q2_K | 2 | ~7% | High | Emergency only |

**VRAM Calculator:**
- Input: Model size in billions of params
- Select: quantization type
- Output: estimated VRAM requirement
- Shows: "Will fit on RTX 5090 (32GB)" / "Will fit on RTX 4080 Super (16GB)" / "Needs both GPUs"

**KV Cache Quantization** (separate from model weights):
- Explanation of what KV cache is
- Shows VRAM savings at different context lengths
- Links to the Hardware config page

---

## Cursor Context Files for Phase 3
- `CONTEXT.md`
- `DB_SCHEMA.md`
- `UI_DESIGN.md`
- `PHASE_1_MODEL_MANAGEMENT.md`

---

## Estimated Cursor Sessions
1-2 sessions.
