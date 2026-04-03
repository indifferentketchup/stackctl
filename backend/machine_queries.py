"""SQLite helpers for machines and model_assignments."""

from __future__ import annotations

from typing import Any

import aiosqlite

from db import DB_PATH


async def assignment_for_model(model_name: str) -> dict[str, Any] | None:
    n = (model_name or "").strip()
    if not n:
        return None
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT ma.model_name AS model_name, ma.machine_id AS machine_id,
                   m.name AS machine_name, m.ollama_url AS ollama_url,
                   m.ssh_host AS ssh_host, m.ssh_user AS ssh_user, m.ssh_type AS ssh_type
            FROM model_assignments ma
            JOIN machines m ON m.id = ma.machine_id
            WHERE ma.model_name = ?
            """,
            (n,),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def all_assignments_map() -> dict[str, tuple[int | None, str | None]]:
    """model_name -> (machine_id, machine_name)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT ma.model_name AS model_name, m.id AS machine_id, m.name AS machine_name
            FROM model_assignments ma
            JOIN machines m ON m.id = ma.machine_id
            """
        ) as cur:
            rows = await cur.fetchall()
    out: dict[str, tuple[int | None, str | None]] = {}
    for r in rows:
        out[str(r["model_name"])] = (int(r["machine_id"]), str(r["machine_name"]))
    return out


async def list_machines() -> list[dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, ollama_url, ssh_host, ssh_user, ssh_type, gpu_label, is_default, created_at "
            "FROM machines ORDER BY name"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def machine_row(machine_id: int) -> dict[str, Any] | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, ollama_url, ssh_host, ssh_user, ssh_type, gpu_label, is_default, created_at "
            "FROM machines WHERE id = ?",
            (machine_id,),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None
