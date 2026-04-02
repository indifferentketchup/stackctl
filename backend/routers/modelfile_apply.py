"""
SSH into sam-desktop and apply a Modelfile via `ollama create`.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncssh
import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth_deps import require_admin
from routers.ollama import _ollama_base, _sse, _stream_ollama_pull
from sam_ssh import (
    connect_sam_desktop,
    iter_ssh_cmd_lines,
    powershell_single_quote,
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


class PullAndCreateBody(BaseModel):
    hf_ref: str
    name: str
    template: str = "chatml"
    parameters: dict[str, Any] = {}


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
    *,
    emit_done: bool = True,
) -> AsyncIterator[dict[str, Any]]:
    fname = f"ollamactl_modelfile_{uuid.uuid4().hex}.txt"
    conn: asyncssh.SSHClientConnection | None = None
    remote_path = ""
    try:
        try:
            conn = await connect_sam_desktop()
        except OSError as e:
            yield {"type": "error", "message": str(e)}
            return

        remote_path = await remote_temp_modelfile_path(conn, fname)
        await ssh_write_file(conn, remote_path, modelfile)

        if overwrite:
            show_ps = (
                "powershell -NoProfile -Command "
                + powershell_single_quote(f"ollama show {name}")
            )
            chk = await conn.run(show_ps, check=False, encoding="utf-8")
            if chk.exit_status == 0:
                rm_ps = "powershell -NoProfile -Command " + powershell_single_quote(f"ollama rm {name}")
                exit_rm: int | None = None
                async for text, code in iter_ssh_cmd_lines(conn, rm_ps):
                    if text == "__end__":
                        exit_rm = code
                        break
                    yield {"type": "log", "line": text}
                if exit_rm is None or exit_rm != 0:
                    yield {"type": "error", "message": f"ollama rm exited with code {exit_rm}"}
                    return

        create_inner = f"ollama create {name} -f {remote_path}"
        create_ps = "powershell -NoProfile -Command " + powershell_single_quote(create_inner)
        exit_c: int | None = None
        async for text, code in iter_ssh_cmd_lines(conn, create_ps):
            if text == "__end__":
                exit_c = code
                break
            yield {"type": "log", "line": text}

        if exit_c is None or exit_c != 0:
            yield {"type": "error", "message": f"ollama create exited with code {exit_c}"}
            return
        if emit_done:
            yield {"type": "done", "success": True}
    finally:
        if conn:
            if remote_path:
                await ssh_remove_file(conn, remote_path)
            conn.close()
            await conn.wait_closed()


async def _apply_sse_gen(body: ApplyBody) -> AsyncIterator[bytes]:
    n = (body.name or "").strip()
    mf = body.modelfile or ""
    if not n:
        yield _sse(json.dumps({"type": "error", "message": "name is required"}))
        return
    if not mf.strip():
        yield _sse(json.dumps({"type": "error", "message": "modelfile is required"}))
        return
    async for ev in _ssh_ollama_apply_stream(n, mf, body.overwrite):
        yield _sse(json.dumps(ev))
        if ev.get("type") == "error":
            return


@router.post("/apply")
async def apply_modelfile_ssh(body: ApplyBody, _owner: dict = Depends(require_admin)):
    return StreamingResponse(
        _apply_sse_gen(body),
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


async def _pull_and_create_gen(body: PullAndCreateBody) -> AsyncIterator[bytes]:
    hf = (body.hf_ref or "").strip()
    name = (body.name or "").strip()
    if not hf:
        yield _sse(json.dumps({"type": "error", "message": "hf_ref is required"}))
        return
    if not name:
        yield _sse(json.dumps({"type": "error", "message": "name is required"}))
        return
    tpl = (body.template or "chatml").strip().lower()
    if tpl not in TEMPLATES:
        yield _sse(json.dumps({"type": "error", "message": f"Invalid template: {body.template}"}))
        return

    params = dict(body.parameters or {})
    if "stop" not in params or not params["stop"]:
        params["stop"] = list(DEFAULT_STOP_TOKENS.get(tpl, DEFAULT_STOP_TOKENS["chatml"]))

    yield _sse(json.dumps({"type": "log", "line": f"[pull] starting {hf}"}))

    pull_ok = False
    async for raw in _stream_ollama_pull(hf):
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

    if not pull_ok:
        yield _sse(json.dumps({"type": "error", "message": "Pull did not complete successfully"}))
        return

    base = _ollama_base()
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

    async for ev in _ssh_ollama_apply_stream(name, new_mf, True, emit_done=False):
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
    return StreamingResponse(
        _pull_and_create_gen(body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
