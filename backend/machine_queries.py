"""SQLite helpers for machine registry."""

from __future__ import annotations

from typing import Any

import aiosqlite

from db import DB_PATH


async def list_machines() -> list[dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, ip, os, ssh_user, prom_job, gpu_prom_job, framework, framework_url, "
            "framework_config_path, framework_restart_cmd, created_at "
            "FROM machines ORDER BY name"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def machine_row(machine_id: int) -> dict[str, Any] | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, ip, os, ssh_user, prom_job, gpu_prom_job, framework, framework_url, "
            "framework_config_path, framework_restart_cmd, created_at "
            "FROM machines WHERE id = ?",
            (machine_id,),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None
