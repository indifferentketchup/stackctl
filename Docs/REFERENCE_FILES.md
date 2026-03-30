# OllamaCtl — Reference Files Checklist
Last updated: March 2026

This document lists every external file needed as Cursor context for each phase.
All boolab files are in the `indifferentketchup/boolab` repo.

---

## Always include in every Cursor session
These are the OllamaCtl project's own docs — keep them in the repo root:
- `CONTEXT.md`
- `DB_SCHEMA.md`
- `UI_DESIGN.md`
- `IMPLEMENTATION_PLAN.md`

---

## Phase 1 — Core Model Management
**No external files needed.** Phase 1 bootstraps from scratch.

Generated during Phase 1 (keep for later phases):
- `backend/main.py`
- `backend/routers/ollama.py`
- `backend/routers/settings.py`
- `backend/db.py`
- `frontend/src/App.jsx`
- `frontend/src/components/Shell.jsx`

---

## Phase 2 — Persona Sync
From **boolab repo:**
- `backend/routers/personas.py` — understand the API shape and all persona fields
- `frontend/src/pages/booops/AISettings.jsx` — existing persona UI (the thing we're improving upon)

From **OllamaCtl (generated in Phase 1):**
- `backend/main.py`
- `frontend/src/App.jsx`

---

## Phase 3 — Multi-GPU + Quantization
From **OllamaCtl (Phase 1):**
- `backend/main.py`
- `backend/routers/ollama.py`
- `frontend/src/App.jsx`

No boolab files needed for this phase.

**External documentation to reference (include as comments in the Cursor prompt):**
- Ollama env var reference: https://github.com/ollama/ollama/blob/main/docs/faq.md
- CUDA_VISIBLE_DEVICES behavior
- NSSM service env var commands for Windows

---

## Phase 4 — Model Import
From **OllamaCtl (Phase 1):**
- `backend/main.py`
- `backend/routers/ollama.py`
- `backend/routers/models.py` (if split from ollama.py)
- `frontend/src/pages/models/CreateModelPage.jsx` (Phase 1 output)

No boolab files needed for this phase.

---

## Phase 5 — RAG Control
From **boolab repo** (critical — reuse exact patterns):
- `backend/services/rag.py` — full RAG retrieval pipeline
- `backend/services/chunking.py` — chunking logic (PDF/DOCX/TXT/MD)
- `backend/services/embeddings.py` — Ollama embedding calls
- `backend/routers/sources.py` — source upload/ingest router

From **OllamaCtl (Phase 1):**
- `backend/main.py`
- `backend/db.py`
- `frontend/src/App.jsx`

---

## Phase 6 — Agents + Flows
From **boolab repo:**
- `backend/routers/chats.py` (boolab) — SSE streaming pattern to reuse for agent runs
- `backend/routers/ollama.py` (boolab) — streaming chat proxy pattern

From **OllamaCtl (all prior phases):**
- `backend/main.py`
- `backend/routers/ollama.py`
- `backend/routers/agents.py` (Phase 6 Session 1 output)
- `frontend/src/App.jsx`
- `frontend/src/pages/agents/AgentDetailPage.jsx` (Session 1 output, needed for Session 2+)

---

## Files to create in the OllamaCtl repo before starting

The following files should be added to the repo root as permanent project documentation. They are inputs to every Cursor session:

```
ollamactl/
├── CONTEXT.md                    ← Project context (this project's equivalent of boolab_context.md)
├── DB_SCHEMA.md                  ← SQLite schema
├── UI_DESIGN.md                  ← Design system + page specs
├── IMPLEMENTATION_PLAN.md        ← Master phased plan
├── PHASE_1_MODEL_MANAGEMENT.md   ← Phase 1 spec
├── PHASE_2_PERSONA_SYNC.md       ← Phase 2 spec
├── PHASE_3_GPU_QUANTIZATION.md   ← Phase 3 spec
├── PHASE_4_MODEL_IMPORT.md       ← Phase 4 spec
├── PHASE_5_RAG_CONTROL.md        ← Phase 5 spec
└── PHASE_6_AGENTS_FLOWS.md       ← Phase 6 spec
```

---

## Notes
- Never include the full boolab `schema.sql` in OllamaCtl Cursor sessions — it's large and irrelevant
- Never include boolab `frontend/src/pages/booops/AISettings.jsx` after Phase 2 — too large and no longer relevant
- For Phase 5+, the boolab RAG service files are the most important reference — they contain the exact patterns OllamaCtl should replicate for ChromaDB interaction
