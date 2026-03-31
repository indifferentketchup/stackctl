"""SQLite helpers for future phases (GPU config, RAG, etc.)."""

from __future__ import annotations

import os

import aiosqlite

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DB_PATH = os.environ.get("DB_PATH", os.path.join(_REPO_ROOT, "ollamactl.db"))


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS gpu_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS gpu_config_baseline (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                json TEXT NOT NULL DEFAULT '{}',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
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
        await db.commit()
