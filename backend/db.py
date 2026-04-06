"""SQLite helpers for future phases (GPU config, RAG, etc.)."""

from __future__ import annotations

import os

import aiosqlite

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DB_PATH = os.environ.get("DB_PATH", os.path.join(_REPO_ROOT, "stackctl.db"))


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute("DROP TABLE IF EXISTS gpu_config_baseline")
        await db.execute("DROP TABLE IF EXISTS gpu_config")
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS rag_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS agents (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              description TEXT,
              model TEXT NOT NULL,
              system_prompt TEXT NOT NULL,
              tools TEXT NOT NULL DEFAULT '[]',
              memory_enabled INTEGER DEFAULT 0,
              memory_window INTEGER DEFAULT 10,
              temperature REAL DEFAULT 0.6,
              top_k INTEGER DEFAULT 20,
              top_p REAL DEFAULT 0.95,
              num_ctx INTEGER DEFAULT 8192,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_runs (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              messages TEXT NOT NULL DEFAULT '[]',
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS flows (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              description TEXT,
              definition TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS flow_runs (
              id TEXT PRIMARY KEY,
              flow_id TEXT NOT NULL,
              status TEXT DEFAULT 'pending',
              trace TEXT NOT NULL DEFAULT '[]',
              input TEXT,
              output TEXT,
              started_at TIMESTAMP,
              completed_at TIMESTAMP,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS machines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                ollama_url TEXT NOT NULL,
                ssh_host TEXT,
                ssh_user TEXT,
                ssh_type TEXT NOT NULL DEFAULT 'nssm',
                gpu_label TEXT,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS model_assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model_name TEXT NOT NULL UNIQUE,
                machine_id INTEGER NOT NULL REFERENCES machines(id),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        await db.commit()

    await _seed_machines_and_assignments()


async def _seed_machines_and_assignments() -> None:
    sd_host = (os.environ.get("SAMDESKTOP_HOST") or "").strip()
    sd_user = (os.environ.get("SAMDESKTOP_USER") or "").strip()
    gpu_host_e = (os.environ.get("GPU_HOST") or "").strip()
    gpu_user = (os.environ.get("GPU_USER") or "").strip()
    sd_url = (os.environ.get("SAMDESKTOP_OLLAMA_URL") or os.environ.get("OLLAMA_URL") or "").strip()
    gpu_url = (os.environ.get("GPU_OLLAMA_URL") or "").strip()
    if not sd_url and sd_host:
        sd_url = f"http://{sd_host}:11434"
    if not gpu_url and gpu_host_e:
        gpu_url = f"http://{gpu_host_e}:11434"
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        async with db.execute("SELECT COUNT(*) FROM machines") as cur:
            row = await cur.fetchone()
            n_m = int(row[0] if row else 0)
        if n_m == 0 and sd_url and gpu_url and sd_host and sd_user and gpu_host_e and gpu_user:
            await db.execute(
                """
                INSERT INTO machines (name, ollama_url, ssh_host, ssh_user, ssh_type, gpu_label, is_default)
                VALUES
                  ('sam-desktop', ?, ?, ?, 'nssm', 'RTX 5090 32GB', 0),
                  ('gpu', ?, ?, ?, 'systemd', 'RTX 4080 Super 16GB', 0)
                """,
                (sd_url, sd_host, sd_user, gpu_url, gpu_host_e, gpu_user),
            )
            await db.commit()

        async with db.execute("SELECT COUNT(*) FROM model_assignments") as cur:
            row2 = await cur.fetchone()
            n_a = int(row2[0] if row2 else 0)
        if n_a == 0:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, name FROM machines WHERE name IN ('sam-desktop', 'gpu')"
            ) as cur:
                rows = await cur.fetchall()
            by_name = {str(r["name"]): int(r["id"]) for r in rows}
            mid_gpu = by_name.get("gpu")
            mid_sd = by_name.get("sam-desktop")
            if mid_gpu is not None and mid_sd is not None:
                pairs = [
                    ("qwen3.5:9b", mid_gpu),
                    ("qwen3-embedding:latest", mid_gpu),
                    ("qwen3.5:27b", mid_sd),
                    ("qwen3-coder:30b", mid_sd),
                ]
                for model_name, mid in pairs:
                    await db.execute(
                        """
                        INSERT INTO model_assignments (model_name, machine_id, created_at, updated_at)
                        VALUES (?, ?, datetime('now'), datetime('now'))
                        """,
                        (model_name, mid),
                    )
                await db.commit()
