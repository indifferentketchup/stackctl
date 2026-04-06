"""SSH machine registry (env-driven) + boolab model routing (SQLite)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_deps import require_admin
from db import DB_PATH
from machines_ssh import (
    gpu_host,
    gpu_user,
    sam_desktop_host,
    sam_desktop_user,
    ssh_exec,
    ssh_stream_lines,
)
from routers.ollama import _sse

router = APIRouter()


def _configured_machines() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    h, u = sam_desktop_host(), sam_desktop_user()
    if h and u:
        out.append(
            {
                "id": "sam-desktop",
                "name": "sam-desktop",
                "ssh_host": h,
                "ssh_user": u,
                "platform": "windows",
            }
        )
    gh, gu = gpu_host(), gpu_user()
    if gh and gu:
        out.append(
            {
                "id": "gpu",
                "name": "gpu",
                "ssh_host": gh,
                "ssh_user": gu,
                "platform": "linux",
            }
        )
    return out


class SshCommandBody(BaseModel):
    command: str = Field(..., min_length=1)


@router.get("")
async def list_machines(_owner: dict = Depends(require_admin)):
    return {"machines": _configured_machines()}


@router.get("/ssh-status")
async def machines_ssh_status(_owner: dict = Depends(require_admin)):
    async def probe(mid: str) -> dict[str, Any]:
        try:
            out, _, code = await ssh_exec(mid, "echo stackctl-ssh-ok")
            ok = code == 0 and "stackctl-ssh-ok" in (out or "")
            return {"id": mid, "connected": ok}
        except OSError:
            return {"id": mid, "connected": False}

    ids = [m["id"] for m in _configured_machines()]
    machines = await asyncio.gather(*[probe(i) for i in ids]) if ids else []
    return {"machines": list(machines)}


@router.get("/route/{model_name:path}")
async def route_model(model_name: str):
    """Public: boolab resolves inference URL for a model (SQLite assignments)."""
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


@router.get("/{machine_id}/status")
async def machine_status(machine_id: str, quick: bool = False, _owner: dict = Depends(require_admin)):
    mids = {m["id"] for m in _configured_machines()}
    if machine_id not in mids:
        raise HTTPException(status_code=404, detail="Unknown machine_id")
    try:
        if quick:
            out, err, code = await ssh_exec(machine_id, "echo stackctl-ssh-ok")
            ok = code == 0 and "stackctl-ssh-ok" in (out or "")
            return {
                "id": machine_id,
                "ssh_ok": ok,
                "gpu": None,
                "stderr": (err or "")[:2000] if not ok else None,
            }
        q = "name,memory.used,memory.free,temperature.gpu,utilization.gpu"
        out, err, code = await ssh_exec(machine_id, f"nvidia-smi --query-gpu={q} --format=csv,noheader")
        ssh_ok = code == 0 and bool((out or "").strip())
        rows: list[dict[str, str]] = []
        if ssh_ok:
            for line in (out or "").strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 5:
                    rows.append(
                        {
                            "name": parts[0],
                            "memory_used_mib": parts[1],
                            "memory_free_mib": parts[2],
                            "temperature_c": parts[3],
                            "utilization_percent": parts[4],
                        }
                    )
        return {
            "id": machine_id,
            "ssh_ok": ssh_ok,
            "gpu": rows if rows else None,
            "stderr": (err or "")[:2000] if not ssh_ok else None,
        }
    except OSError as e:
        return {"id": machine_id, "ssh_ok": False, "gpu": None, "stderr": str(e)[:2000]}


@router.post("/{machine_id}/ssh", dependencies=[Depends(require_admin)])
async def machine_ssh_stream(machine_id: str, body: SshCommandBody):
    mids = {m["id"] for m in _configured_machines()}
    if machine_id not in mids:
        raise HTTPException(status_code=404, detail="Unknown machine_id")

    async def gen():
        try:
            async for line, end in ssh_stream_lines(machine_id, body.command):
                if line == "__end__":
                    yield _sse(json.dumps({"type": "end", "code": int(end or -1)}))
                else:
                    yield _sse(json.dumps({"type": "line", "line": line}))
        except OSError as e:
            yield _sse(json.dumps({"type": "error", "message": str(e)}))

    return StreamingResponse(gen(), media_type="text/event-stream")
