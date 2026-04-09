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
        await db.execute("DROP TABLE IF EXISTS model_assignments")
        await db.execute("DROP TABLE IF EXISTS machines")
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
                ip TEXT NOT NULL,
                os TEXT NOT NULL DEFAULT 'ubuntu',
                ssh_user TEXT NOT NULL,
                ssh_key_path TEXT,
                prom_job TEXT,
                gpu_prom_job TEXT,
                framework TEXT DEFAULT 'none',
                framework_url TEXT,
                framework_config_path TEXT,
                framework_restart_cmd TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        await db.commit()

    await _seed_machines()


async def _seed_machines() -> None:
    sd_host = (os.environ.get("SAMDESKTOP_HOST") or "").strip()
    sd_user = (os.environ.get("SAMDESKTOP_USER") or "").strip()
    sd_key = (os.environ.get("SAMDESKTOP_SSH_KEY") or "").strip() or None
    sd_lswap_url = (os.environ.get("SAMDESKTOP_LLAMASWAP_URL") or "").strip() or None
    sd_lswap_cfg = (os.environ.get("SAMDESKTOP_LLAMASWAP_CONFIG") or "").strip() or None
    gpu_host_v = (os.environ.get("GPU_HOST") or "").strip()
    gpu_user = (os.environ.get("GPU_USER") or "").strip()
    gpu_key = (os.environ.get("GPU_SSH_KEY") or "").strip() or None
    gpu_framework_url = (os.environ.get("GPU_TABBYAPI_URL") or "").strip() or None
    if not gpu_framework_url and gpu_host_v:
        gpu_framework_url = f"http://{gpu_host_v}:9101"

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        async with db.execute("SELECT COUNT(*) FROM machines") as cur:
            row = await cur.fetchone()
            n_m = int(row[0] if row else 0)
        if n_m != 0:
            return

        if sd_host and sd_user:
            await db.execute(
                """
                INSERT INTO machines
                (name, ip, os, ssh_user, ssh_key_path, prom_job, gpu_prom_job, framework, framework_url, framework_config_path, framework_restart_cmd)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "sam-desktop",
                    sd_host,
                    "windows",
                    sd_user,
                    sd_key,
                    "windows_exporter",
                    "nvidia_gpu_exporter_desktop",
                    "llama-swap",
                    sd_lswap_url,
                    sd_lswap_cfg,
                    'cmd /c "C:\\Tools\\nssm\\nssm.exe restart llama-swap"',
                ),
            )

        if gpu_host_v and gpu_user:
            await db.execute(
                """
                INSERT INTO machines
                (name, ip, os, ssh_user, ssh_key_path, prom_job, gpu_prom_job, framework, framework_url, framework_config_path, framework_restart_cmd)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "gpu",
                    gpu_host_v,
                    "ubuntu",
                    gpu_user,
                    gpu_key,
                    "gpu-machine",
                    "dcgm",
                    "tabbyapi",
                    gpu_framework_url,
                    "/opt/tabbyapi/config.yml",
                    "sudo systemctl restart tabbyapi",
                ),
            )

        await db.commit()
