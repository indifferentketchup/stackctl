# Cursor Prompt — ollamactl Phase 6: RAG Control

## Mandatory pre-work
Before writing any code, read these files in full:
- `README.md`
- `src/App.jsx`
- `backend/main.py`
- `backend/routers/ollama.py`

Do not touch any file not explicitly listed below.

---

## Context
RAG in boolab uses ChromaDB at `boolab_chroma:8000` (accessible from homelab at `100.114.205.53:8000` via Docker network or direct). Embeddings are generated via Ollama's `/api/embeddings` endpoint. Sources (documents) are stored in boolab's PostgreSQL `sources` and `source_chunks` tables. ollamactl provides a read/manage interface for RAG — it does not replace boolab's ingest pipeline, but allows browsing, deleting, and re-ingesting sources.

---

## Backend (`backend/routers/rag.py`) — NEW FILE

### Endpoints

**`GET /api/rag/collections`**
- Calls ChromaDB `GET {CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections`
- Returns list of collections with name, id, count

**`GET /api/rag/collections/{collection_id}/chunks`**
- Query params: `limit` (default 20), `offset` (default 0)
- Calls ChromaDB `POST /api/v2/.../collections/{collection_id}/get` with limit/offset
- Returns chunks with id, document text, metadata (source name, chunk index)

**`DELETE /api/rag/collections/{collection_id}`**
- Calls ChromaDB `DELETE /api/v2/.../collections/{collection_id}`
- Returns `{ ok: true }`

**`GET /api/rag/sources`**
- Calls boolab API `GET {BOOLAB_API_URL}/api/sources/{daw_id}` for all DAWs
- Returns all sources across all DAWs with: id, name, daw_id, chunk_count, created_at, status

**`DELETE /api/rag/sources/{source_id}`**
- Calls boolab API `DELETE {BOOLAB_API_URL}/api/sources/{source_id}`
- Returns `{ ok: true }`

**`GET /api/rag/settings`**
- Reads RAG settings from SQLite `rag_settings` table (key/value)
- Returns: `{ top_k_retrieve, top_after_rerank, chunk_size, chunk_overlap, embedding_model, rerank_enabled }`

**`PUT /api/rag/settings`**
- Body: any subset of the above settings
- Upserts into SQLite
- Returns full settings

**`POST /api/rag/test-query`**
- Body: `{ query: str, collection_id: str, top_k: int }`
- Embeds the query via Ollama `/api/embeddings`
- Queries ChromaDB collection with the embedding
- Returns top_k results with text and similarity scores

All endpoints require `require_admin`.
Register in `backend/main.py` with prefix `/api/rag`.

### SQLite schema addition
```sql
CREATE TABLE IF NOT EXISTS rag_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Frontend

### `src/pages/RagPage.jsx` — NEW FILE

**Header:** "RAG Control"

---

**Section 1: Settings**

Card with form:

| Setting | Input | Default | Explanation |
|---|---|---|---|
| Embedding model | dropdown (local models) | `qwen3-embedding:latest` | Model used to embed documents and queries. Must match what was used during ingest. |
| Chunk size | number (100–4000) | `1000` | Characters per chunk. Smaller = more precise retrieval, larger = more context per chunk. |
| Chunk overlap | number (0–500) | `100` | Overlap between adjacent chunks. Prevents cutting off context at boundaries. |
| Top K retrieve | slider (5–100) | `40` | Chunks fetched from ChromaDB before reranking. Higher = better recall, slower. |
| Top after rerank | slider (1–20) | `10` | Chunks injected into system prompt after reranking. Higher = more context, uses more tokens. |
| Reranking | toggle | on | Uses flashrank to reorder chunks by relevance. Disable if speed matters more than accuracy. |

Save button → `PUT /api/rag/settings`

Note banner: "These settings affect new ingestion and retrieval in boolab's 808notes mode. Changes take effect on the next chat or re-ingest."

---

**Section 2: Sources Browser**

Table of all sources across all DAWs:

Columns: Name | DAW | Chunks | Uploaded | Status | Actions

Actions per row:
- View chunks button → opens side panel with chunk list
- Delete button → confirm → deletes source + its ChromaDB vectors

Filter bar: filter by DAW name

Empty state: "No sources found. Upload documents in 808notes to populate RAG."

---

**Section 3: Chunk Viewer (side panel)**

Opens when "View chunks" clicked on a source.

Shows:
- Source name + chunk count
- Searchable list of chunks
- Each chunk: index number, text content (truncated to 300 chars, expandable), metadata

---

**Section 4: ChromaDB Collections**

Collapsible section. For power users.

Table of raw ChromaDB collections:
- Name | ID | Document count | Actions (delete)

Delete collection: confirm dialog with warning "This will delete all vectors for this collection. The source files in boolab will still exist but will need to be re-ingested."

---

**Section 5: Query Tester**

Card with:
- Collection picker (dropdown of all collections)
- Query textarea
- Top K slider (1–20)
- "Run Query" button → calls `/api/rag/test-query`

Results:
- List of matching chunks in order of similarity
- Each shows: similarity score (0–1, color coded green/amber/red), source name, chunk text
- Useful for debugging why a model isn't finding relevant content

---

## Constraints
- CHROMA_URL env var: `http://100.114.205.53:8000` (or via Docker network if backend is on homelab)
- BOOLAB_API_URL env var for sources list
- All ChromaDB API calls use v2 path format: `/api/v2/tenants/default_tenant/databases/default_database/...`
- Chunk viewer is a slide-in panel, not a new page
- Mobile: tables scroll horizontally, side panel is full-screen overlay
- Enable RAG nav item in sidebar
