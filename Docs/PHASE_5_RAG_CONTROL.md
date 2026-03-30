# OllamaCtl — Phase 5: RAG Control
Last updated: March 2026

---

## Goal
Central RAG management dashboard. Manage named RAG configs, upload and index documents, monitor chunk counts, trigger re-indexing, and tune retrieval parameters. Connects to boolab's ChromaDB instance.

---

## Infrastructure Context
- **ChromaDB:** Running in `boolab_chroma` container on ubuntu-homelab at `http://boolab_chroma:8000` (internal Docker network) or `http://100.114.205.53:8000` (Tailscale)
- **Embedding model:** `qwen3-embedding:latest` on sam-desktop via Ollama
- **Boolab RAG config:** `TOP_K_RETRIEVE=40`, `TOP_AFTER_RERANK=10`, flashrank reranker
- **Collections:** Per-DAW ChromaDB collections in boolab

OllamaCtl does NOT replace boolab's RAG — it provides a management UI for the same ChromaDB instance and can create/manage standalone RAG configs for agent use.

---

## Backend Routes

### `GET /api/rag/configs`
Returns all RAG configs from SQLite `rag_configs` table.

### `POST /api/rag/configs`
Creates a new RAG config.

### `PUT /api/rag/configs/{id}`
Updates a RAG config.

### `DELETE /api/rag/configs/{id}`
Deletes config and all associated documents.

### `GET /api/rag/configs/{id}/documents`
Returns documents for a config from `rag_documents` table.

### `POST /api/rag/configs/{id}/documents`
Upload document — multipart file upload. Triggers background indexing job.

### `DELETE /api/rag/configs/{id}/documents/{doc_id}`
Deletes document and removes its chunks from ChromaDB.

### `POST /api/rag/configs/{id}/documents/{doc_id}/reindex`
Re-chunks and re-embeds a single document.

### `POST /api/rag/configs/{id}/reindex-all`
Re-indexes all documents in a config.

### `GET /api/rag/collections`
Lists all ChromaDB collections — proxies to ChromaDB API.

### `GET /api/rag/collections/{name}/stats`
Returns chunk count, document count, embedding model for a ChromaDB collection.

### `DELETE /api/rag/collections/{name}`
Deletes a ChromaDB collection entirely.

### `POST /api/rag/test`
Body: `{"config_id": "...", "query": "...", "top_k": 5}`
Runs a retrieval test query and returns the top chunks with relevance scores.

---

## Frontend Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/rag` | `RAGPage` | Config list + Chroma overview |
| `/rag/configs/:id` | `RAGConfigPage` | Documents for a config |
| `/rag/collections` | `ChromaCollectionsPage` | Raw Chroma collection browser |

---

## RAGPage

### Chroma Overview Card
- Total collections
- Total chunks across all collections
- ChromaDB version
- Connection status

### Boolab Collections Section
- List of boolab's per-DAW collections
- Each shows: collection name | DAW name (if resolvable) | chunk count | last updated
- View chunks button → opens ChromaCollectionsPage for that collection

### OllamaCtl RAG Configs Section
- List of named RAG configs created in OllamaCtl
- Card per config: name | doc count | chunk count | embedding model
- "New Config" button

---

## RAGConfigPage

### Config Settings (collapsible panel)
- Name, description
- Embedding model (dropdown from Ollama models list — filtered to embedding-capable)
- Chunk size slider (100–2000 tokens). Helper: "How large each text chunk is. Smaller = more precise retrieval, less context per chunk. 1000 is a good default."
- Chunk overlap slider (0–500). Helper: "How much adjacent chunks overlap. Prevents context being split mid-sentence."
- Top-K Retrieve slider (5–100). Helper: "How many chunks to fetch from ChromaDB before reranking. More = better recall, slower retrieval."
- Top-K After Rerank slider (1–20). Helper: "How many chunks to inject into the prompt after reranking. These are what the model actually sees."
- Reranker toggle. Helper: "Uses flashrank to reorder retrieved chunks by relevance to the query. Recommended on."
- Save config button

### Documents List
Table: Filename | Size | Status | Chunks | Indexed At | Actions

Status badges:
- `pending` — grey, not yet indexed
- `indexing` — amber spinner, in progress
- `indexed` — green checkmark
- `error` — red, shows error message on hover

Actions per row: Re-index | Delete

Bulk actions: Re-index all | Delete all

### Upload Area
Drag-and-drop zone + click-to-browse:
- Supported: PDF, DOCX, TXT, MD
- Max file size: 50MB
- Multiple files at once
- Upload progress per file
- Shows indexing status after upload

### Test Retrieval Panel
Collapsible at bottom of page:
- Query input
- Top-K slider
- "Run test" button
- Results: ranked list of chunks with relevance scores + source filename + page number

---

## ChromaCollectionsPage
- Dropdown to select collection
- Stats: chunk count, embedding dimensions, distance function
- Search: enter query → shows top N chunks
- Raw browse: paginated list of all chunks
- Delete collection button (destructive, requires confirm)

---

## Indexing Pipeline
Reuses boolab's chunking/embedding pattern:
- PDF: `pypdf` page extraction
- DOCX: `python-docx` paragraph extraction  
- TXT/MD: plain text splitting
- Chunking: character-based with overlap
- Embedding: `POST http://OLLAMA_URL/api/embeddings` with `qwen3-embedding:latest`
- Storage: ChromaDB collection named `ollamactl_{config_id}`

Background indexing runs as an async FastAPI background task. Status updates polled by frontend every 2s.

---

## Cursor Context Files for Phase 5
- `CONTEXT.md`
- `DB_SCHEMA.md`
- `UI_DESIGN.md`
- `PHASE_1_MODEL_MANAGEMENT.md`

**Also include from boolab repo:**
- `backend/services/rag.py` (boolab) — chunking/embedding/retrieval patterns to reuse
- `backend/services/chunking.py` (boolab) — chunking logic
- `backend/services/embeddings.py` (boolab) — embedding logic

---

## Estimated Cursor Sessions
2 sessions.
