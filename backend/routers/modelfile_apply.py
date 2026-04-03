"""
SSH into sam-desktop and apply a Modelfile via `ollama create`.
"""

from __future__ import annotations

import asyncio
import json
import re
import shlex
import uuid
from collections.abc import AsyncIterator
from typing import Any

import aiosqlite
import asyncssh
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth_deps import require_admin
from db import DB_PATH
from machine_queries import assignment_for_model, machine_row
from routers.ollama import _sse, _stream_ollama_pull
from sam_ssh import (
    connect_sam_desktop,
    connect_ssh,
    iter_ssh_cmd_lines,
    powershell_single_quote,
    remote_temp_linux_path,
    remote_temp_modelfile_path,
    sam_desktop_host,
    sam_desktop_user,
    ssh_remove_file,
    ssh_write_file,
)
from templates import DEFAULT_STOP_TOKENS, TEMPLATES

router = APIRouter()

_TWO_GB = 2 * 1024 * 1024 * 1024

_FROM_LINE_RE = re.compile(r"(?im)^FROM\s+(.+)$")


class ApplyBody(BaseModel):
    name: str
    modelfile: str
    overwrite: bool = False
    machine_id: int | None = None


class PullAndCreateBody(BaseModel):
    hf_ref: str
    name: str
    template: str = "chatml"
    parameters: dict[str, Any] = {}
    machine_id: int | None = None


async def _require_assign(model_name: str, machine_id: int | None) -> dict[str, Any]:
    n = (model_name or "").strip()
    if machine_id is not None:
        row = await machine_row(machine_id)
        if not row:
            raise HTTPException(status_code=400, detail="Unknown machine_id")
        return {
            "model_name": n,
            "machine_id": row["id"],
            "machine_name": row["name"],
            "ollama_url": row["ollama_url"],
            "ssh_host": row["ssh_host"],
            "ssh_user": row["ssh_user"],
            "ssh_type": row["ssh_type"],
        }
    assign = await assignment_for_model(n)
    if not assign:
        raise HTTPException(
            status_code=422,
            detail="No machine assigned. Provide machine_id in the request.",
        )
    return assign


async def _upsert_model_assignment(model_name: str, machine_id: int) -> None:
    n = (model_name or "").strip()
    if not n:
        return
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO model_assignments (model_name, machine_id, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(model_name) DO UPDATE SET
                machine_id = excluded.machine_id,
                updated_at = datetime('now')
            """,
            (n, machine_id),
        )
        await db.commit()


def _kv_blob_size(info: dict[str, Any] | None) -> int | None:
    if not info:
        return None
    det = info.get("details")
    if isinstance(det, dict):
        sz = det.get("size")
        if isinstance(sz, (int, float)) and sz > 0:
            return int(sz)
    for key in ("general.size", "general.file_size"):
        v = info.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return int(v)
    return None


def _digest_from_from_line(from_arg: str) -> str | None:
    s = from_arg.strip().strip('"').strip("'")
    m = re.search(r"(sha256-[a-f0-9]{64}|sha256:[a-f0-9]{64})", s, re.I)
    if m:
        d = m.group(1).lower().replace(":", "-")
        if d.startswith("sha256-") and len(d) == 71:
            return d
    return None


def _size_for_digest(show: dict[str, Any], digest: str) -> int | None:
    dlow = digest.lower()
    for block in (show.get("model_info"), show.get("projector_info")):
        if not isinstance(block, dict):
            continue
        for k, v in block.items():
            if dlow in k.lower():
                if isinstance(v, dict):
                    sz = v.get("size")
                    if isinstance(sz, (int, float)) and sz > 0:
                        return int(sz)
            if isinstance(k, str) and k.lower() == dlow and isinstance(v, (int, float)) and v > 0:
                return int(v)
    return None


def _extract_from_specs(modelfile: str) -> list[tuple[str, str]]:
    specs: list[tuple[str, str]] = []
    for m in _FROM_LINE_RE.finditer(modelfile or ""):
        arg = m.group(1).strip()
        specs.append((m.group(0), arg))
    return specs


def _pick_primary_from_target(modelfile: str, show: dict[str, Any]) -> str:
    specs = _extract_from_specs(modelfile)
    if not specs:
        raise ValueError("Modelfile has no FROM line")
    if len(specs) == 1:
        return specs[0][1]

    mi = show.get("model_info") if isinstance(show.get("model_info"), dict) else {}
    pi = show.get("projector_info") if isinstance(show.get("projector_info"), dict) else {}

    scored: list[tuple[str, int]] = []
    for idx, (_, arg) in enumerate(specs):
        sz = None
        d = _digest_from_from_line(arg)
        if d:
            sz = _size_for_digest(show, d)
        if sz is None:
            sz = _kv_blob_size(mi if idx == 0 else pi)
        if sz is None:
            sz = _kv_blob_size(pi if idx == 0 else mi)
        if sz is not None:
            scored.append((arg, sz))

    if len(scored) >= 2:
        return max(scored, key=lambda x: x[1])[0]
    if scored:
        return max(scored, key=lambda x: x[1])[0]

    for idx, (_, arg) in enumerate(specs):
        d = _digest_from_from_line(arg)
        if d:
            sz = _size_for_digest(show, d)
            if sz is not None and sz >= _TWO_GB:
                return arg

    return specs[0][1]


def _build_modelfile_from_parts(
    from_target: str,
    template_key: str,
    parameters: dict[str, Any],
) -> str:
    if template_key not in TEMPLATES:
        raise ValueError(f"Unknown template: {template_key}")
    tmpl = TEMPLATES[template_key]
    lines = [f"FROM {from_target}", "", f'TEMPLATE """{tmpl}"""', ""]

    temp = float(parameters.get("temperature", 0.6))
    top_p = float(parameters.get("top_p", 0.95))
    top_k = int(parameters.get("top_k", 20))
    repeat_penalty = float(parameters.get("repeat_penalty", 1.0))
    lines.append(f"PARAMETER temperature {temp}")
    lines.append(f"PARAMETER top_p {top_p}")
    lines.append(f"PARAMETER top_k {top_k}")
    lines.append(f"PARAMETER repeat_penalty {repeat_penalty}")

    if "num_ctx" in parameters and parameters["num_ctx"] is not None:
        lines.append(f"PARAMETER num_ctx {int(parameters['num_ctx'])}")

    stops = parameters.get("stop")
    if isinstance(stops, list):
        for st in stops:
            if isinstance(st, str) and st.strip():
                escaped = st.strip().replace('"', '\\"')
                lines.append(f'PARAMETER stop "{escaped}"')

    return "\n".join(lines) + "\n"


async def _ssh_ollama_apply_stream(
    name: str,
    modelfile: str,
    overwrite: bool,
    assign: dict[str, Any],
    *,
    emit_done: bool = True,
) -> AsyncIterator[dict[str, Any]]:
    host = (assign.get("ssh_host") or "").strip()
    user = (assign.get("ssh_user") or "").strip()
    ssh_type = (str(assign.get("ssh_type") or "nssm")).strip().lower()
    if not host or not user:
        yield {"type": "error", "message": "Machine has no SSH host/user configured"}
        return

    fname = f"ollamactl_modelfile_{uuid.uuid4().hex}.txt"
    conn: asyncssh.SSHClientConnection | None = None
    remote_path = ""
    try:
        try:
            conn = await connect_ssh(host, user)
        except OSError as e:
            yield {"type": "error", "message": str(e)}
            return

        if ssh_type == "systemd":
            remote_path = await remote_temp_linux_path(conn, "mf")
        else:
            remote_path = await remote_temp_modelfile_path(conn, fname)
        await ssh_write_file(conn, remote_path, modelfile)

        qn = shlex.quote(name)

        if overwrite:
            if ssh_type == "systemd":
                chk = await conn.run(f"ollama show {qn}", check=False, encoding="utf-8")
            else:
                show_ps = (
                    "powershell -NoProfile -Command "
                    + powershell_single_quote(f"ollama show {name}")
                )
                chk = await conn.run(show_ps, check=False, encoding="utf-8")
            if chk.exit_status == 0:
                if ssh_type == "systemd":
                    rm_cmd = f"ollama rm {qn}"
                else:
                    rm_cmd = "powershell -NoProfile -Command " + powershell_single_quote(f"ollama rm {name}")
                exit_rm: int | None = None
                async for text, code in iter_ssh_cmd_lines(conn, rm_cmd):
                    if text == "__end__":
                        exit_rm = code
                        break
                    yield {"type": "log", "line": text}
                if exit_rm is None or exit_rm != 0:
                    yield {"type": "error", "message": f"ollama rm exited with code {exit_rm}"}
                    return

        create_inner = f"ollama create {name} -f {remote_path}"
        if ssh_type == "systemd":
            create_cmd = f"ollama create {qn} -f {shlex.quote(remote_path)}"
        else:
            create_cmd = "powershell -NoProfile -Command " + powershell_single_quote(create_inner)
        exit_c: int | None = None
        async for text, code in iter_ssh_cmd_lines(conn, create_cmd):
            if text == "__end__":
                exit_c = code
                break
            yield {"type": "log", "line": text}

        if exit_c is None or exit_c != 0:
            yield {"type": "error", "message": f"ollama create exited with code {exit_c}"}
            return
        mid = assign.get("machine_id")
        if mid is not None:
            await _upsert_model_assignment(name, int(mid))
        if emit_done:
            yield {"type": "done", "success": True}
    finally:
        if conn:
            if remote_path:
                await ssh_remove_file(conn, remote_path)
            conn.close()
            await conn.wait_closed()


async def _apply_sse_gen(body: ApplyBody, assign: dict[str, Any] | None) -> AsyncIterator[bytes]:
    n = (body.name or "").strip()
    mf = body.modelfile or ""
    if not n:
        yield _sse(json.dumps({"type": "error", "message": "name is required"}))
        return
    if not mf.strip():
        yield _sse(json.dumps({"type": "error", "message": "modelfile is required"}))
        return
    assert assign is not None
    async for ev in _ssh_ollama_apply_stream(n, mf, body.overwrite, assign):
        yield _sse(json.dumps(ev))
        if ev.get("type") == "error":
            return


@router.post("/apply")
async def apply_modelfile_ssh(body: ApplyBody, _owner: dict = Depends(require_admin)):
    n = (body.name or "").strip()
    assign = await _require_assign(n, body.machine_id) if n else None
    return StreamingResponse(
        _apply_sse_gen(body, assign),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/ssh-status")
async def ssh_status():
    host = sam_desktop_host()
    user = sam_desktop_user()
    err: str | None = None
    connected = False
    try:
        conn = await asyncio.wait_for(connect_sam_desktop(), timeout=8.0)
        connected = True
        conn.close()
        await conn.wait_closed()
    except asyncio.TimeoutError:
        err = "Connection timed out"
    except OSError as e:
        err = str(e)
    except asyncssh.Error as e:
        err = str(e)
    return {"connected": connected, "host": host, "user": user, "error": err}


async def _pull_and_create_gen(
    body: PullAndCreateBody, assign: dict[str, Any] | None
) -> AsyncIterator[bytes]:
    hf = (body.hf_ref or "").strip()
    name = (body.name or "").strip()
    if not hf:
        yield _sse(json.dumps({"type": "error", "message": "hf_ref is required"}))
        return
    if not name:
        yield _sse(json.dumps({"type": "error", "message": "name is required"}))
        return
    assert assign is not None
    base = str(assign["ollama_url"]).rstrip("/")
    tpl = (body.template or "chatml").strip().lower()
    if tpl not in TEMPLATES:
        yield _sse(json.dumps({"type": "error", "message": f"Invalid template: {body.template}"}))
        return

    params = dict(body.parameters or {})
    if "stop" not in params or not params["stop"]:
        params["stop"] = list(DEFAULT_STOP_TOKENS.get(tpl, DEFAULT_STOP_TOKENS["chatml"]))

    yield _sse(json.dumps({"type": "log", "line": f"[pull] starting {hf}"}))

    pull_ok = False
    q: asyncio.Queue[bytes | None] = asyncio.Queue()

    async def _pull_to_queue() -> None:
        try:
            async for raw in _stream_ollama_pull(hf, base_override=base):
                await q.put(raw)
        finally:
            await q.put(None)

    task = asyncio.create_task(_pull_to_queue())
    try:
        while True:
            try:
                raw = await asyncio.wait_for(q.get(), timeout=15.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n".encode()
                continue
            if raw is None:
                break
            payload = raw.decode("utf-8", errors="replace").strip()
            if not payload.startswith("data: "):
                continue
            inner = payload[6:].strip()
            if inner == "[DONE]":
                pull_ok = True
                yield _sse(json.dumps({"type": "log", "line": "[pull] completed"}))
                break
            try:
                chunk = json.loads(inner)
            except json.JSONDecodeError:
                continue
            if chunk.get("error"):
                yield _sse(json.dumps({"type": "error", "message": chunk["error"]}))
                return
            status = chunk.get("status", "")
            total = chunk.get("total", 0) or 0
            completed = chunk.get("completed", 0) or 0
            if total:
                yield _sse(
                    json.dumps(
                        {"type": "progress", "status": status, "total": int(total), "completed": int(completed)}
                    )
                )
            elif status:
                yield _sse(json.dumps({"type": "log", "line": f"[pull] {status}"}))
            if chunk.get("status") == "success":
                pull_ok = True
                yield _sse(json.dumps({"type": "log", "line": "[pull] completed"}))
                break
    finally:
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    if not pull_ok:
        yield _sse(json.dumps({"type": "error", "message": "Pull did not complete successfully"}))
        return

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            r = await client.post(f"{base}/api/show", json={"name": hf, "verbose": True})
    except httpx.HTTPError as e:
        yield _sse(json.dumps({"type": "error", "message": f"show request failed: {e}"}))
        return

    if r.status_code >= 400:
        detail = r.text[:2000] if r.text else r.reason_phrase
        yield _sse(json.dumps({"type": "error", "message": f"Ollama show failed: {detail}"}))
        return

    try:
        show = r.json()
    except Exception:
        yield _sse(json.dumps({"type": "error", "message": "Invalid JSON from Ollama show"}))
        return

    mf_src = str(show.get("modelfile") or "")
    try:
        from_tgt = _pick_primary_from_target(mf_src, show)
    except ValueError as e:
        yield _sse(json.dumps({"type": "error", "message": str(e)}))
        return

    yield _sse(json.dumps({"type": "log", "line": f"[modelfile] using FROM {from_tgt[:120]}…"}))

    try:
        new_mf = _build_modelfile_from_parts(from_tgt, tpl, params)
    except ValueError as e:
        yield _sse(json.dumps({"type": "error", "message": str(e)}))
        return

    yield _sse(json.dumps({"type": "log", "line": f"[ssh] applying model as {name}"}))

    async for ev in _ssh_ollama_apply_stream(name, new_mf, True, assign, emit_done=False):
        yield _sse(json.dumps(ev))
        if ev.get("type") == "error":
            return

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            dr = await client.request("DELETE", f"{base}/api/delete", json={"name": hf})
    except httpx.HTTPError as e:
        yield _sse(json.dumps({"type": "error", "message": f"Cleanup delete failed: {e}"}))
        return

    if dr.status_code >= 400 and dr.status_code != 404:
        det = dr.text[:2000] if dr.text else dr.reason_phrase
        yield _sse(json.dumps({"type": "error", "message": f"Delete HF model failed: {det}"}))
        return

    yield _sse(json.dumps({"type": "log", "line": f"[cleanup] removed {hf}"}))
    yield _sse(json.dumps({"type": "done", "success": True}))


@router.post("/pull-and-create")
async def pull_and_create(body: PullAndCreateBody, _owner: dict = Depends(require_admin)):
    name = (body.name or "").strip()
    assign = await _require_assign(name, body.machine_id) if name else None
    return StreamingResponse(
        _pull_and_create_gen(body, assign),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
