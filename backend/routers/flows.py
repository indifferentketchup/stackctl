"""Flow CRUD, execution (SSE), n8n export."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_deps import require_admin
from db import DB_PATH
from flow_nodes.runner import run_flow_linear, ssh_node_kinds
from routers.ollama import _sse
from machines_ssh import connect_sam_desktop

router = APIRouter()


class FlowCreate(BaseModel):
    name: str = Field(..., min_length=1)
    description: str = ""
    definition: dict[str, Any] = Field(default_factory=lambda: {"nodes": [], "edges": []})


class FlowUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    definition: dict[str, Any] | None = None


class RunFlowBody(BaseModel):
    input: str = ""


def _parse_defn(raw: str) -> dict[str, Any]:
    try:
        d = json.loads(raw or "{}")
        return d if isinstance(d, dict) else {"nodes": [], "edges": []}
    except json.JSONDecodeError:
        return {"nodes": [], "edges": []}


async def _get_flow_row(flow_id: str) -> aiosqlite.Row | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM flows WHERE id = ?", (flow_id,)) as cur:
            return await cur.fetchone()


@router.get("")
async def list_flows(_owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM flows ORDER BY updated_at DESC") as cur:
            rows = await cur.fetchall()
    out = []
    for r in rows:
        d = dict(r)
        dfn = _parse_defn(str(d.get("definition") or "{}"))
        d["definition"] = dfn
        n = len(dfn.get("nodes") or [])
        d["node_count"] = n
        out.append(d)
    return {"flows": out}


@router.post("", dependencies=[Depends(require_admin)])
async def create_flow(body: FlowCreate):
    fid = uuid.uuid4().hex
    blob = json.dumps(body.definition or {"nodes": [], "edges": []}, ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO flows (id, name, description, definition)
            VALUES (?,?,?,?)
            """,
            (fid, body.name.strip(), (body.description or "").strip(), blob),
        )
        await db.commit()
    row = await _get_flow_row(fid)
    if not row:
        raise HTTPException(500, "failed")
    d = dict(row)
    d["definition"] = _parse_defn(str(d["definition"] or "{}"))
    return d


@router.get("/{flow_id}")
async def get_flow(flow_id: str, _owner: dict = Depends(require_admin)):
    row = await _get_flow_row(flow_id)
    if not row:
        raise HTTPException(404)
    d = dict(row)
    d["definition"] = _parse_defn(str(d["definition"] or "{}"))
    return d


@router.put("/{flow_id}")
async def update_flow(flow_id: str, body: FlowUpdate, _owner: dict = Depends(require_admin)):
    cur = await get_flow(flow_id, _owner)
    name = body.name if body.name is not None else cur["name"]
    desc = body.description if body.description is not None else cur["description"]
    defn = body.definition if body.definition is not None else cur["definition"]
    blob = json.dumps(defn, ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE flows SET name=?, description=?, definition=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
            """,
            (str(name).strip(), str(desc or "").strip(), blob, flow_id),
        )
        await db.commit()
    return await get_flow(flow_id, _owner)


@router.delete("/{flow_id}")
async def delete_flow(flow_id: str, _owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM flow_runs WHERE flow_id = ?", (flow_id,))
        await db.execute("DELETE FROM flows WHERE id = ?", (flow_id,))
        await db.commit()
    return {"ok": True}


async def _ssh_ok() -> bool:
    try:
        conn = await asyncio.wait_for(connect_sam_desktop(), timeout=8.0)
        conn.close()
        await conn.wait_closed()
        return True
    except Exception:
        return False


async def _run_flow_sse(flow_id: str, input_text: str) -> AsyncIterator[bytes]:
    row = await _get_flow_row(flow_id)
    if not row:
        yield _sse(json.dumps({"type": "error", "message": "flow not found"}))
        return
    d = dict(row)
    defn = _parse_defn(str(d.get("definition") or "{}"))

    if ssh_node_kinds(defn) and not await _ssh_ok():
        yield _sse(
            json.dumps(
                {
                    "type": "error",
                    "message": "sam-desktop unreachable; flow contains SSH nodes",
                }
            )
        )
        return

    run_id = uuid.uuid4().hex
    trace: list[dict[str, Any]] = []
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO flow_runs (id, flow_id, status, trace, input, started_at)
            VALUES (?,?,?,?,?, CURRENT_TIMESTAMP)
            """,
            (run_id, flow_id, "running", json.dumps(trace), input_text),
        )
        await db.commit()

    try:
        output = await run_flow_linear(defn, input_text, trace)

        for step in trace:
            yield _sse(
                json.dumps(
                    {
                        "type": "node_start",
                        "node_id": step.get("node_id"),
                        "node_type": step.get("node_type"),
                        "node_label": step.get("node_label"),
                    }
                )
            )
            if step.get("status") == "error":
                yield _sse(
                    json.dumps(
                        {
                            "type": "node_error",
                            "node_id": step.get("node_id"),
                            "error": step.get("error"),
                        }
                    )
                )
            else:
                yield _sse(
                    json.dumps(
                        {
                            "type": "node_output",
                            "node_id": step.get("node_id"),
                            "output": step.get("output"),
                        }
                    )
                )

        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """
                UPDATE flow_runs SET status=?, trace=?, output=?, completed_at=CURRENT_TIMESTAMP
                WHERE id=?
                """,
                ("completed", json.dumps(trace, ensure_ascii=False), output, run_id),
            )
            await db.commit()

        yield _sse(json.dumps({"type": "done", "output": output, "run_id": run_id}))
    except Exception as e:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                """
                UPDATE flow_runs SET status=?, trace=?, completed_at=CURRENT_TIMESTAMP
                WHERE id=?
                """,
                ("failed", json.dumps(trace + [{"error": str(e)}], ensure_ascii=False), run_id),
            )
            await db.commit()
        yield _sse(json.dumps({"type": "error", "message": str(e)}))


@router.post("/{flow_id}/run")
async def run_flow(flow_id: str, body: RunFlowBody, _owner: dict = Depends(require_admin)):
    return StreamingResponse(
        _run_flow_sse(flow_id, body.input or ""),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{flow_id}/runs")
async def list_flow_runs(flow_id: str, _owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, flow_id, status, started_at, completed_at, created_at FROM flow_runs WHERE flow_id = ? ORDER BY created_at DESC",
            (flow_id,),
        ) as cur:
            rows = await cur.fetchall()
    return {"runs": [dict(r) for r in rows]}


@router.get("/{flow_id}/runs/{run_id}")
async def get_flow_run(flow_id: str, run_id: str, _owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM flow_runs WHERE id = ? AND flow_id = ?",
            (run_id, flow_id),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404)
    r = dict(row)
    try:
        r["trace"] = json.loads(r.get("trace") or "[]")
    except json.JSONDecodeError:
        r["trace"] = []
    return r


class N8nFlowExport(BaseModel):
    ollama_url: str = ""
    ollamactl_url: str = "http://localhost:8000"


@router.post("/{flow_id}/export-n8n")
async def export_n8n(flow_id: str, body: N8nFlowExport, _owner: dict = Depends(require_admin)):
    flow = await get_flow(flow_id, _owner)
    base = (body.ollamactl_url or "").rstrip("/")
    ollama = (body.ollama_url or os.environ.get("OLLAMA_URL") or "http://100.101.41.16:11434").rstrip(
        "/"
    )
    _ = flow["definition"]
    wf = {
        "name": flow["name"][:80],
        "meta": {"templateCredsSetupCompleted": True},
        "nodes": [
            {
                "parameters": {},
                "id": "trig",
                "name": "Manual Trigger",
                "type": "n8n-nodes-base.manualTrigger",
                "typeVersion": 1,
                "position": [200, 300],
            },
            {
                "parameters": {
                    "method": "POST",
                    "url": f"{base}/api/flows/{flow_id}/run",
                    "sendBody": True,
                    "jsonParameters": True,
                    "bodyParametersJson": '={"input": "{{$json.input}}"}',
                },
                "id": "runflow",
                "name": "Run ollamactl flow",
                "type": "n8n-nodes-base.httpRequest",
                "typeVersion": 4,
                "position": [420, 300],
            },
        ],
        "connections": {
            "Manual Trigger": {"main": [[{"node": "Run ollamactl flow", "type": "main", "index": 0}]]}
        },
        "settings": {"executionOrder": "v1"},
        "staticData": None,
        "tags": [],
        "triggerCount": 0,
        "notes": f"Ollama host reference: {ollama}. Import in n8n → Workflows → Import.",
    }
    return wf
