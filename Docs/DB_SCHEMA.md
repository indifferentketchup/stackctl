# OllamaCtl — Database Schema
Last updated: March 2026

## Database
SQLite at `/data/ollamactl.db`. Applied on startup via `db.py:apply_schema()`.

---

## Tables

### `agents`
Saved agent configurations with system prompts, tools, and model bindings.

```sql
CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    tools       TEXT NOT NULL DEFAULT '[]',  -- JSON array of tool names
    temperature REAL NOT NULL DEFAULT 0.6,
    top_p       REAL NOT NULL DEFAULT 0.95,
    top_k       INTEGER NOT NULL DEFAULT 20,
    max_tokens  INTEGER NOT NULL DEFAULT 2048,
    context_window INTEGER NOT NULL DEFAULT 16384,
    think       INTEGER NOT NULL DEFAULT 0,  -- 0/1 bool: enable thinking mode
    color       TEXT NOT NULL DEFAULT '#7c3aed',
    icon_emoji  TEXT NOT NULL DEFAULT '🤖',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `flows`
Multi-step agent pipelines. Steps stored as JSON.

```sql
CREATE TABLE IF NOT EXISTS flows (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    steps       TEXT NOT NULL DEFAULT '[]',  -- JSON array of flow step objects
    trigger     TEXT NOT NULL DEFAULT 'manual',  -- manual | schedule | webhook
    schedule    TEXT,                            -- cron string if trigger=schedule
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Flow step object shape:
```json
{
  "id": "uuid",
  "type": "llm | tool | condition | output",
  "agent_id": "uuid or null",
  "model": "model name or null",
  "prompt_template": "string",
  "input_from": "user | step_id",
  "output_to": "next | end",
  "condition": "string expression or null"
}
```

### `rag_configs`
Named RAG configurations — chunk settings, embedding models, retrieval params.

```sql
CREATE TABLE IF NOT EXISTS rag_configs (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    embedding_model TEXT NOT NULL DEFAULT 'qwen3-embedding:latest',
    chunk_size      INTEGER NOT NULL DEFAULT 1000,
    chunk_overlap   INTEGER NOT NULL DEFAULT 200,
    top_k_retrieve  INTEGER NOT NULL DEFAULT 40,
    top_k_rerank    INTEGER NOT NULL DEFAULT 10,
    rerank_enabled  INTEGER NOT NULL DEFAULT 1,
    collection_name TEXT NOT NULL DEFAULT 'default',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `rag_documents`
Documents uploaded and indexed under a RAG config.

```sql
CREATE TABLE IF NOT EXISTS rag_documents (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    rag_config_id   TEXT NOT NULL REFERENCES rag_configs(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | indexing | indexed | error
    error_message   TEXT,
    indexed_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `gpu_configs`
Saved GPU environment profiles for Ollama.

```sql
CREATE TABLE IF NOT EXISTS gpu_configs (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    gpu_ids         TEXT NOT NULL DEFAULT '[]',  -- JSON array: ["0"] or ["0","1"]
    gpu_memory_fraction REAL NOT NULL DEFAULT 0.9,
    kv_cache_type   TEXT NOT NULL DEFAULT 'f16',  -- f16 | q8_0 | q4_0
    num_parallel    INTEGER NOT NULL DEFAULT 1,
    flash_attention INTEGER NOT NULL DEFAULT 1,
    max_loaded_models INTEGER NOT NULL DEFAULT 1,
    keep_alive      TEXT NOT NULL DEFAULT '30m',
    active          INTEGER NOT NULL DEFAULT 0,  -- only one can be active
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `model_notes`
User-written notes attached to local Ollama models.

```sql
CREATE TABLE IF NOT EXISTS model_notes (
    model_name  TEXT PRIMARY KEY,
    notes       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array of tag strings
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `import_jobs`
Tracks model import operations (GGUF/safetensors).

```sql
CREATE TABLE IF NOT EXISTS import_jobs (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    model_name  TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'gguf',  -- gguf | safetensors | hf
    source_path TEXT,        -- local path or HF repo
    modelfile   TEXT,        -- generated Modelfile content
    quant_type  TEXT,        -- q4_k_m | q8_0 | etc
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `settings`
Key-value store for app-level settings.

```sql
CREATE TABLE IF NOT EXISTS settings (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL DEFAULT ''
);

-- Seed defaults
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('ollama_url', 'http://100.101.41.16:11434'),
    ('boolab_api_url', 'http://100.114.205.53:9300'),
    ('app_title', 'OllamaCtl'),
    ('theme_accent', '#e91e8c');
```

---

## Notes
- All IDs are hex UUIDs generated by SQLite `randomblob` — no external dep
- JSON columns stored as TEXT, parsed in Python on read
- `apply_schema()` runs `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` on every startup — idempotent
- No migrations needed for additive changes — use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern
