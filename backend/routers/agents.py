"""Agent CRUD, chat runs (Ollama via HTTP), exports."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import aiosqlite
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_deps import require_admin
from db import DB_PATH
from routers.ollama import _ollama_base, _sse
from tools.registry import execute_tool, ollama_tool_schema

router = APIRouter()


def _ollama_chat_url() -> str:
    return _ollama_base() + "/api/chat"


class AgentCreate(BaseModel):
    name: str = Field(..., min_length=1)
    description: str = ""
    model: str = Field(..., min_length=1)
    system_prompt: str = Field(..., min_length=1)
    tools: list[dict[str, Any]] = []
    memory_enabled: bool = False
    memory_window: int = Field(10, ge=1, le=50)
    temperature: float = 0.6
    top_k: int = 20
    top_p: float = 0.95
    num_ctx: int = 8192


class AgentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    tools: list[dict[str, Any]] | None = None
    memory_enabled: bool | None = None
    memory_window: int | None = Field(None, ge=1, le=50)
    temperature: float | None = None
    top_k: int | None = None
    top_p: float | None = None
    num_ctx: int | None = None


class RunBody(BaseModel):
    message: str = Field(..., min_length=1)
    run_id: str | None = None


def _tools_to_ollama(tool_entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for t in tool_entries:
        tid = str(t.get("tool") or "")
        sch = ollama_tool_schema(tid)
        if sch:
            out.append(sch)
    return out


def _tool_config_map(tool_entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(t.get("tool")): dict(t.get("config") or {}) for t in tool_entries if t.get("tool")}


def _row_to_agent(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    d["memory_enabled"] = bool(d.get("memory_enabled"))
    try:
        d["tools"] = json.loads(d.get("tools") or "[]")
    except json.JSONDecodeError:
        d["tools"] = []
    if not isinstance(d["tools"], list):
        d["tools"] = []
    return d


@router.get("")
async def list_agents(_owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM agents ORDER BY updated_at DESC") as cur:
            rows = await cur.fetchall()
    return {"agents": [_row_to_agent(r) for r in rows]}


@router.post("", dependencies=[Depends(require_admin)])
async def create_agent(body: AgentCreate):
    aid = uuid.uuid4().hex
    tools_blob = json.dumps(body.tools or [], ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO agents (
              id, name, description, model, system_prompt, tools,
              memory_enabled, memory_window, temperature, top_k, top_p, num_ctx
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                aid,
                body.name.strip(),
                (body.description or "").strip(),
                body.model.strip(),
                body.system_prompt,
                tools_blob,
                1 if body.memory_enabled else 0,
                int(body.memory_window),
                float(body.temperature),
                int(body.top_k),
                float(body.top_p),
                int(body.num_ctx),
            ),
        )
        await db.commit()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM agents WHERE id = ?", (aid,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(500, "create failed")
    return _row_to_agent(row)


@router.get("/{agent_id}")
async def get_agent(agent_id: str, _owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "agent not found")
    return _row_to_agent(row)


@router.put("/{agent_id}")
async def update_agent(agent_id: str, body: AgentUpdate, _owner: dict = Depends(require_admin)):
    cur_agent = await get_agent(agent_id, _owner)
    name = body.name if body.name is not None else cur_agent["name"]
    desc = body.description if body.description is not None else cur_agent["description"]
    model = body.model if body.model is not None else cur_agent["model"]
    sp = body.system_prompt if body.system_prompt is not None else cur_agent["system_prompt"]
    tools = body.tools if body.tools is not None else cur_agent["tools"]
    mem = body.memory_enabled if body.memory_enabled is not None else cur_agent["memory_enabled"]
    mw = body.memory_window if body.memory_window is not None else cur_agent["memory_window"]
    temp = body.temperature if body.temperature is not None else cur_agent["temperature"]
    tk = body.top_k if body.top_k is not None else cur_agent["top_k"]
    tp = body.top_p if body.top_p is not None else cur_agent["top_p"]
    nc = body.num_ctx if body.num_ctx is not None else cur_agent["num_ctx"]
    tools_blob = json.dumps(tools or [], ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE agents SET
              name=?, description=?, model=?, system_prompt=?, tools=?,
              memory_enabled=?, memory_window=?, temperature=?, top_k=?, top_p=?, num_ctx=?,
              updated_at=CURRENT_TIMESTAMP
            WHERE id=?
            """,
            (
                str(name).strip(),
                str(desc or "").strip(),
                str(model).strip(),
                sp,
                tools_blob,
                1 if mem else 0,
                int(mw),
                float(temp),
                int(tk),
                float(tp),
                int(nc),
                agent_id,
            ),
        )
        await db.commit()
    return await get_agent(agent_id, _owner)


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str, _owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM agent_runs WHERE agent_id = ?", (agent_id,))
        await db.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        await db.commit()
    return {"ok": True}


@router.get("/{agent_id}/runs")
async def list_runs(agent_id: str, _owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, agent_id, created_at FROM agent_runs WHERE agent_id = ? ORDER BY created_at DESC",
            (agent_id,),
        ) as cur:
            rows = await cur.fetchall()
    return {"runs": [dict(r) for r in rows]}


@router.delete("/{agent_id}/runs/{run_id}")
async def delete_run(agent_id: str, run_id: str, _owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM agent_runs WHERE id = ? AND agent_id = ?",
            (run_id, agent_id),
        )
        await db.commit()
    return {"ok": True}


async def _load_run_messages(run_id: str) -> list[dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT messages FROM agent_runs WHERE id = ?",
            (run_id,),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return []
    try:
        m = json.loads(row[0] or "[]")
        return m if isinstance(m, list) else []
    except json.JSONDecodeError:
        return []


async def _save_run_messages(run_id: str, messages: list[dict[str, Any]]) -> None:
    blob = json.dumps(messages, ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE agent_runs SET messages = ? WHERE id = ?",
            (blob, run_id),
        )
        await db.commit()


async def _run_sse_gen(agent_id: str, body: RunBody) -> AsyncIterator[bytes]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        yield _sse(json.dumps({"type": "error", "message": "agent not found"}))
        return
    ag = _row_to_agent(row)

    run_id = (body.run_id or "").strip() or uuid.uuid4().hex
    user_text = body.message.strip()

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM agent_runs WHERE id = ? AND agent_id = ?",
            (run_id, agent_id),
        ) as cur:
            exists = await cur.fetchone()
        if not exists:
            await db.execute(
                "INSERT INTO agent_runs (id, agent_id, messages) VALUES (?,?,?)",
                (run_id, agent_id, "[]"),
            )
            await db.commit()

    messages: list[dict[str, Any]] = await _load_run_messages(run_id)
    if ag.get("memory_enabled"):
        window = int(ag.get("memory_window") or 10)
        messages = messages[-(window * 2) :]

    tool_entries: list[dict[str, Any]] = []
    for item in ag.get("tools") or []:
        if isinstance(item, dict) and item.get("tool"):
            tool_entries.append({"tool": str(item["tool"]), "config": item.get("config") or {}})

    sys_prompt = str(ag.get("system_prompt") or "")
    ollama_tools = _tools_to_ollama(tool_entries) if tool_entries else []
    cfg_map = _tool_config_map(tool_entries)

    ollama_msgs: list[dict[str, Any]] = [{"role": "system", "content": sys_prompt}]
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role in ("user", "assistant"):
            ollama_msgs.append({k: v for k, v in m.items() if k in ("role", "content", "tool_calls")})
        elif role == "tool":
            tm: dict[str, Any] = {"role": "tool", "content": str(m.get("content", ""))}
            if m.get("name"):
                tm["name"] = m["name"]
            ollama_msgs.append(tm)
    ollama_msgs.append({"role": "user", "content": user_text})

    base_url = _ollama_chat_url()
    options = {
        "temperature": float(ag.get("temperature", 0.6)),
        "top_k": int(ag.get("top_k", 20)),
        "top_p": float(ag.get("top_p", 0.95)),
        "num_ctx": int(ag.get("num_ctx", 8192)),
    }

    max_rounds = 6
    assistant_accum = ""

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            for _round in range(max_rounds):
                payload: dict[str, Any] = {
                    "model": ag["model"],
                    "messages": ollama_msgs,
                    "stream": False,
                    "options": options,
                }
                if ollama_tools:
                    payload["tools"] = ollama_tools

                try:
                    r = await client.post(base_url, json=payload)
                except httpx.HTTPError as e:
                    yield _sse(json.dumps({"type": "error", "message": str(e)}))
                    return
                if r.status_code >= 400:
                    yield _sse(
                        json.dumps(
                            {
                                "type": "error",
                                "message": r.text[:2000] or r.reason_phrase,
                            }
                        )
                    )
                    return
                try:
                    data = r.json()
                except Exception:
                    yield _sse(json.dumps({"type": "error", "message": "bad JSON from Ollama"}))
                    return

                msg = data.get("message") if isinstance(data, dict) else None
                if not isinstance(msg, dict):
                    yield _sse(json.dumps({"type": "error", "message": "no message from Ollama"}))
                    return

                tool_calls = msg.get("tool_calls")
                if tool_calls and isinstance(tool_calls, list):
                    ollama_msgs.append(
                        {
                            "role": "assistant",
                            "content": msg.get("content") or "",
                            "tool_calls": tool_calls,
                        }
                    )
                    for tc in tool_calls:
                        if not isinstance(tc, dict):
                            continue
                        fn = (tc.get("function") or {}) if isinstance(tc.get("function"), dict) else {}
                        name = str(fn.get("name") or tc.get("name") or "")
                        raw_args = fn.get("arguments") or tc.get("arguments") or "{}"
                        try:
                            args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                        except json.JSONDecodeError:
                            args = {}
                        if not isinstance(args, dict):
                            args = {}
                        yield _sse(json.dumps({"type": "tool_call", "tool": name, "args": args}))
                        cfg = cfg_map.get(name, {})
                        result = await execute_tool(name, cfg, args)
                        yield _sse(json.dumps({"type": "tool_result", "tool": name, "result": result}))
                        ollama_msgs.append({"role": "tool", "content": result, "name": name})
                    continue

                assistant_accum = str(msg.get("content") or "")
                break
            else:
                yield _sse(json.dumps({"type": "error", "message": "tool loop limit"}))
                return
    except Exception as e:
        yield _sse(json.dumps({"type": "error", "message": str(e)}))
        return

    for i in range(0, len(assistant_accum), 48):
        chunk = assistant_accum[i : i + 48]
        yield _sse(json.dumps({"type": "token", "content": chunk}))

    new_hist = messages + [{"role": "user", "content": user_text}]
    if assistant_accum:
        new_hist.append({"role": "assistant", "content": assistant_accum})
    await _save_run_messages(run_id, new_hist)

    yield _sse(json.dumps({"type": "done"}))


@router.post("/{agent_id}/run")
async def run_agent(agent_id: str, body: RunBody, _owner: dict = Depends(require_admin)):
    return StreamingResponse(
        _run_sse_gen(agent_id, body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class N8nExportBody(BaseModel):
    ollamactl_url: str = "http://localhost:5173"


@router.post("/{agent_id}/export-n8n")
async def export_n8n(agent_id: str, body: N8nExportBody, _owner: dict = Depends(require_admin)):
    ag = await get_agent(agent_id, _owner)
    base = body.ollamactl_url.rstrip("/")
    wf = {
        "name": f"ollamactl-agent-{ag['name'][:40]}",
        "nodes": [
            {
                "parameters": {},
                "id": "start",
                "name": "Start",
                "type": "n8n-nodes-base.manualTrigger",
                "typeVersion": 1,
                "position": [0, 0],
            },
            {
                "parameters": {
                    "method": "POST",
                    "url": f"{base}/api/agents/{agent_id}/run",
                    "sendHeaders": True,
                    "headerParameters": {
                        "parameters": [{"name": "Authorization", "value": "=Bearer {{$credentials.token}}"}]
                    },
                    "sendBody": True,
                    "jsonParameters": True,
                    "bodyParametersJson": '={"message": "{{$json.chatInput}}"}',
                },
                "id": "http",
                "name": "Agent run",
                "type": "n8n-nodes-base.httpRequest",
                "typeVersion": 4,
                "position": [260, 0],
            },
        ],
        "connections": {"Start": {"main": [[{"node": "Agent run", "type": "main", "index": 0}]]}},
    }
    return wf


@router.post("/{agent_id}/export-daw")
async def export_daw(agent_id: str, _owner: dict = Depends(require_admin)):
    ag = await get_agent(agent_id, _owner)
    base = (os.environ.get("BOOLAB_API_URL") or "").rstrip("/")
    if not base:
        raise HTTPException(503, "BOOLAB_API_URL is not set")
    headers: dict[str, str] = {}
    tok = (os.environ.get("BOOLAB_OWNER_TOKEN") or "").strip()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            r = await client.post(
                f"{base}/api/daws/",
                headers=headers,
                json={
                    "name": ag["name"],
                    "description": ag.get("description") or "",
                    "system_prompt": ag["system_prompt"],
                    "model": ag["model"],
                },
            )
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text[:2000])
        return r.json()
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e)) from e
