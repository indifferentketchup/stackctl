"""Machine registry, model→machine assignments, and routing for boolab."""

from __future__ import annotations

from typing import Any

import aiosqlite
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_deps import require_admin
from db import DB_PATH

router = APIRouter()


class MachineCreate(BaseModel):
    name: str = Field(..., min_length=1)
    ollama_url: str = Field(..., min_length=1)
    ssh_host: str | None = None
    ssh_user: str | None = None
    ssh_type: str = "nssm"
    gpu_label: str | None = None
    is_default: int = 0


class MachineUpdate(BaseModel):
    name: str | None = None
    ollama_url: str | None = None
    ssh_host: str | None = None
    ssh_user: str | None = None
    ssh_type: str | None = None
    gpu_label: str | None = None
    is_default: int | None = None


class AssignmentBody(BaseModel):
    model_name: str = Field(..., min_length=1)
    machine_id: int = Field(..., ge=1)


def _norm_ssh_type(raw: str) -> str:
    s = (raw or "nssm").strip().lower()
    if s not in ("nssm", "systemd"):
        raise HTTPException(status_code=400, detail='ssh_type must be "nssm" or "systemd"')
    return s


async def _ollama_reachable_and_tags(ollama_url: str) -> tuple[bool, dict[str, Any] | None]:
    base = ollama_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            r = await client.get(f"{base}/api/tags")
            if r.status_code != 200:
                return False, None
            return True, r.json()
    except httpx.HTTPError:
        return False, None


async def _running_count(ollama_url: str) -> int:
    base = ollama_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            r = await client.get(f"{base}/api/ps")
            if r.status_code != 200:
                return 0
            data = r.json()
            models = data.get("models") if isinstance(data, dict) else None
            if isinstance(models, list):
                return len(models)
    except httpx.HTTPError:
        return 0
    return 0


@router.get("")
async def list_machines(_owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, ollama_url, ssh_host, ssh_user, ssh_type, gpu_label, is_default, created_at "
            "FROM machines ORDER BY name"
        ) as cur:
            rows = await cur.fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        reachable, _ = await _ollama_reachable_and_tags(str(d["ollama_url"]))
        d["reachable"] = reachable
        d["running_count"] = await _running_count(str(d["ollama_url"])) if reachable else 0
        out.append(d)
    return {"machines": out}


@router.post("", dependencies=[Depends(require_admin)])
async def create_machine(body: MachineCreate):
    st = _norm_ssh_type(body.ssh_type)
    name = body.name.strip()
    url = body.ollama_url.strip()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """
            INSERT INTO machines (name, ollama_url, ssh_host, ssh_user, ssh_type, gpu_label, is_default)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (
                name,
                url,
                (body.ssh_host or "").strip() or None,
                (body.ssh_user or "").strip() or None,
                st,
                (body.gpu_label or "").strip() or None,
                1 if body.is_default else 0,
            ),
        ) as cur:
            rid_row = await cur.fetchone()
        await db.commit()
    rid = int(rid_row[0]) if rid_row else 0
    return {"id": rid, "ok": True}


@router.put("/{machine_id}", dependencies=[Depends(require_admin)])
async def update_machine(machine_id: int, body: MachineUpdate):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM machines WHERE id = ?", (machine_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Machine not found")
        cur = dict(row)
        new_name = body.name.strip() if body.name is not None else cur["name"]
        new_url = body.ollama_url.strip() if body.ollama_url is not None else cur["ollama_url"]
        new_host = cur["ssh_host"]
        if body.ssh_host is not None:
            new_host = body.ssh_host.strip() or None
        new_user = cur["ssh_user"]
        if body.ssh_user is not None:
            new_user = body.ssh_user.strip() or None
        new_type = _norm_ssh_type(body.ssh_type) if body.ssh_type is not None else str(cur["ssh_type"])
        new_label = cur["gpu_label"]
        if body.gpu_label is not None:
            new_label = body.gpu_label.strip() or None
        new_def = cur["is_default"]
        if body.is_default is not None:
            new_def = 1 if body.is_default else 0
        await db.execute(
            """
            UPDATE machines SET name = ?, ollama_url = ?, ssh_host = ?, ssh_user = ?, ssh_type = ?,
                gpu_label = ?, is_default = ?
            WHERE id = ?
            """,
            (new_name, new_url, new_host, new_user, new_type, new_label, new_def, machine_id),
        )
        await db.commit()
    return {"ok": True}


@router.delete("/{machine_id}", dependencies=[Depends(require_admin)])
async def delete_machine(machine_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM model_assignments WHERE machine_id = ?", (machine_id,)
        ) as cur:
            n = int((await cur.fetchone())[0])
        if n > 0:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot delete machine: {n} model assignment(s) still reference it",
            )
        cur = await db.execute("DELETE FROM machines WHERE id = ?", (machine_id,))
        await db.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Machine not found")
    return {"ok": True}


@router.get("/assignments")
async def list_assignments(_owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT ma.id, ma.model_name, ma.machine_id, m.name AS machine_name, ma.created_at, ma.updated_at
            FROM model_assignments ma
            JOIN machines m ON m.id = ma.machine_id
            ORDER BY ma.model_name
            """
        ) as cur:
            rows = await cur.fetchall()
    return {"assignments": [dict(r) for r in rows]}


@router.post("/assignments", dependencies=[Depends(require_admin)])
async def upsert_assignment(body: AssignmentBody):
    model_name = body.model_name.strip()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id FROM machines WHERE id = ?", (body.machine_id,)) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=400, detail="Unknown machine_id")
        await db.execute(
            """
            INSERT INTO model_assignments (model_name, machine_id, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(model_name) DO UPDATE SET
                machine_id = excluded.machine_id,
                updated_at = datetime('now')
            """,
            (model_name, body.machine_id),
        )
        await db.commit()
    return {"ok": True}


@router.delete("/assignments/{model_name:path}", dependencies=[Depends(require_admin)])
async def delete_assignment(model_name: str):
    n = (model_name or "").strip()
    if not n:
        raise HTTPException(status_code=400, detail="model_name is required")
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("DELETE FROM model_assignments WHERE model_name = ?", (n,))
        await db.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Assignment not found")
    return {"ok": True}


@router.get("/route/{model_name:path}")
async def route_model(model_name: str):
    """Public: boolab backend resolves Ollama URL for a model (no admin auth)."""
    n = (model_name or "").strip()
    if not n:
        raise HTTPException(status_code=400, detail="model_name is required")
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT m.id, m.name, m.ollama_url
            FROM model_assignments ma
            JOIN machines m ON m.id = ma.machine_id
            WHERE ma.model_name = ?
            """,
            (n,),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Model '{n}' is not assigned to any machine")
    d = dict(row)
    return {
        "machine_id": int(d["id"]),
        "machine_name": str(d["name"]),
        "ollama_url": str(d["ollama_url"]).rstrip("/"),
    }
