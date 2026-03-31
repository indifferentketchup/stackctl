"""GPU / Ollama environment config — status from Ollama APIs, desired config SQLite, NSSM via SSH."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from typing import Any

import aiosqlite
import asyncssh
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_deps import require_admin
from db import DB_PATH
from sam_ssh import connect_sam_desktop, iter_ssh_cmd_lines, powershell_single_quote
from routers.ollama import _ollama_base, _sse

router = APIRouter()

NSSM_EXE = r"C:\Tools\nssm.exe"
OLLAMA_SERVICE = "OllamaService"

TRACKED_ENV_KEYS = (
    "CUDA_VISIBLE_DEVICES",
    "OLLAMA_GPU_LAYERS",
    "OLLAMA_MAX_LOADED_MODELS",
    "OLLAMA_KEEP_ALIVE",
    "OLLAMA_FLASH_ATTENTION",
    "OLLAMA_KV_CACHE_TYPE",
    "OLLAMA_NUM_PARALLEL",
    "OLLAMA_HOST",
)

NSSM_FORM_KEYS = (
    "CUDA_VISIBLE_DEVICES",
    "OLLAMA_GPU_LAYERS",
    "OLLAMA_MAX_LOADED_MODELS",
    "OLLAMA_KEEP_ALIVE",
    "OLLAMA_FLASH_ATTENTION",
    "OLLAMA_KV_CACHE_TYPE",
    "OLLAMA_NUM_PARALLEL",
    "OLLAMA_HOST",
)


def _extract_gpu_info(ps: dict[str, Any]) -> str:
    parts: list[str] = []
    for k in ("gpu", "gpus", "processor"):
        v = ps.get(k)
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, str) and item.strip():
                    parts.append(item.strip())
                elif isinstance(item, dict):
                    name = item.get("name") or item.get("device")
                    if isinstance(name, str) and name.strip():
                        parts.append(name.strip())
    models = ps.get("models")
    if isinstance(models, list):
        for m in models:
            if not isinstance(m, dict):
                continue
            for key in ("device", "gpu", "gpu_name", "ollama_engine"):
                val = m.get(key)
                if isinstance(val, str) and val.strip():
                    parts.append(val.strip())
    dedup: list[str] = []
    seen: set[str] = set()
    for p in parts:
        key = p.lower()
        if key not in seen:
            seen.add(key)
            dedup.append(p)
    return "; ".join(dedup) if dedup else ""


def _vram_from_models(ps: dict[str, Any]) -> int | None:
    models = ps.get("models")
    if not isinstance(models, list):
        return None
    total = 0
    any_n = False
    for m in models:
        if not isinstance(m, dict):
            continue
        raw = m.get("size_vram")
        if raw is None:
            raw = m.get("vram")
        if raw is None:
            continue
        try:
            total += int(raw)
            any_n = True
        except (TypeError, ValueError):
            continue
    return total if any_n else None


@router.get("/status", dependencies=[Depends(require_admin)])
async def gpu_status():
    base = _ollama_base()
    ps: dict[str, Any] = {}
    version_str = ""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            pr = await client.get(f"{base}/api/ps")
            pr.raise_for_status()
            ps = pr.json()
            if not isinstance(ps, dict):
                ps = {}
            vr = await client.get(f"{base}/api/version")
            vr.raise_for_status()
            vdata = vr.json()
            if isinstance(vdata, dict):
                version_str = str(vdata.get("version") or "").strip()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {e}") from e

    models = ps.get("models")
    running_models = models if isinstance(models, list) else []
    return {
        "ollama_version": version_str or None,
        "running_models": running_models,
        "vram_used_bytes": _vram_from_models(ps),
        "gpu_info": _extract_gpu_info(ps) or None,
    }


async def _all_config_rows() -> list[dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT key, value, updated_at FROM gpu_config ORDER BY key"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def _baseline_dict() -> dict[str, str]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT json FROM gpu_config_baseline WHERE id = 1") as cur:
            row = await cur.fetchone()
    raw = row[0] if row else "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) if v is not None else "" for k, v in data.items()}


async def _pending_changes() -> bool:
    baseline = await _baseline_dict()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            f"SELECT key, value FROM gpu_config WHERE key IN ({','.join('?' * len(TRACKED_ENV_KEYS))})",
            TRACKED_ENV_KEYS,
        ) as cur:
            rows = await cur.fetchall()
    current = {k: "" for k in TRACKED_ENV_KEYS}
    for k, v in rows:
        current[str(k)] = str(v) if v is not None else ""
    for k in TRACKED_ENV_KEYS:
        b = baseline.get(k, "")
        c = current.get(k, "")
        if str(c) != str(b):
            return True
    return False


class GpuConfigUpsert(BaseModel):
    key: str = Field(..., min_length=1)
    value: str = ""


@router.get("/config", dependencies=[Depends(require_admin)])
async def get_gpu_config():
    entries = await _all_config_rows()
    pending = await _pending_changes()
    config_map: dict[str, str] = {e["key"]: e["value"] for e in entries}
    return {"entries": entries, "config": config_map, "pending_changes": pending}


@router.put("/config", dependencies=[Depends(require_admin)])
async def put_gpu_config(body: GpuConfigUpsert):
    key = body.key.strip()
    if key.startswith("__"):
        raise HTTPException(status_code=400, detail="invalid key")
    val = body.value if body.value is not None else ""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO gpu_config (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            """,
            (key, val),
        )
        await db.commit()
    entries = await _all_config_rows()
    pending = await _pending_changes()
    config_map: dict[str, str] = {e["key"]: e["value"] for e in entries}
    return {"entries": entries, "config": config_map, "pending_changes": pending}


@router.post("/mark-applied", dependencies=[Depends(require_admin)])
async def mark_gpu_config_applied():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            f"SELECT key, value FROM gpu_config WHERE key IN ({','.join('?' * len(TRACKED_ENV_KEYS))})",
            TRACKED_ENV_KEYS,
        ) as cur:
            rows = await cur.fetchall()
    snap: dict[str, str] = {k: "" for k in TRACKED_ENV_KEYS}
    for k, v in rows:
        if k in snap:
            snap[k] = str(v) if v is not None else ""
    blob = json.dumps(snap, sort_keys=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO gpu_config_baseline (id, json, updated_at)
            VALUES (1, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                json = excluded.json,
                updated_at = CURRENT_TIMESTAMP
            """,
            (blob,),
        )
        await db.commit()
    entries = await _all_config_rows()
    pending = await _pending_changes()
    config_map: dict[str, str] = {e["key"]: e["value"] for e in entries}
    return {"entries": entries, "config": config_map, "pending_changes": pending}


_QUOTED_PAIR_RE = re.compile(r'"([^"=]+)=([^"]*)"')


def _parse_nssm_app_environment_extra(stdout: str, stderr: str, exit_code: int) -> tuple[dict[str, str], str | None]:
    if exit_code != 0:
        msg = (stderr or stdout or "").strip() or f"nssm exited with code {exit_code}"
        low = msg.lower()
        if "not found" in low or "cannot find" in low or "does not exist" in low or "找不到" in msg:
            return {}, msg
        return {}, msg

    raw = (stdout or "").strip()
    if not raw:
        return {}, None

    env: dict[str, str] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line and not line.startswith('"'):
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"')
            if k:
                env[k] = v

    if not env:
        for m in _QUOTED_PAIR_RE.finditer(raw):
            env[m.group(1)] = m.group(2)

    if not env and raw:
        if "=" in raw:
            k, _, v = raw.partition("=")
            k, k2 = k.strip(), v
            if k:
                env[k] = k2.strip().strip('"')

    return env, None


def _nssm_get_env_ps() -> str:
    inner = f"& '{NSSM_EXE}' get {OLLAMA_SERVICE} AppEnvironmentExtra"
    return "powershell -NoProfile -Command " + powershell_single_quote(inner)


def _nssm_set_env_ps(pairs: list[str]) -> str:
    ps_args = ",".join(powershell_single_quote(p) for p in pairs)
    inner = f"$a = @({ps_args}); & '{NSSM_EXE}' set {OLLAMA_SERVICE} AppEnvironmentExtra @a"
    return "powershell -NoProfile -Command " + powershell_single_quote(inner)


def _nssm_action_ps(action: str) -> str:
    inner = f"& '{NSSM_EXE}' {action} {OLLAMA_SERVICE}"
    return "powershell -NoProfile -Command " + powershell_single_quote(inner)


@router.get("/nssm-env", dependencies=[Depends(require_admin)])
async def get_nssm_env():
    conn: asyncssh.SSHClientConnection | None = None
    try:
        try:
            conn = await connect_sam_desktop()
        except OSError as e:
            return {"env": {}, "error": str(e)}
        r = await conn.run(_nssm_get_env_ps(), check=False, encoding="utf-8")
        code = r.exit_status if r.exit_status is not None else -1
        raw_out = (r.stdout or "").strip()
        env, err = _parse_nssm_app_environment_extra(r.stdout or "", r.stderr or "", code)
        if err:
            return {"env": {}, "raw": raw_out, "error": err}
        return {"env": env, "raw": raw_out}
    finally:
        if conn:
            conn.close()
            await conn.wait_closed()


class NssmEnvBody(BaseModel):
    env: dict[str, str] = {}


def _pairs_from_body(body: NssmEnvBody) -> list[str]:
    src = body.env or {}
    pairs: list[str] = []
    for key in NSSM_FORM_KEYS:
        val = src.get(key, "")
        sval = "" if val is None else str(val)
        pairs.append(f"{key}={sval}")
    return pairs


async def _stream_ssh_cmd(cmd: str) -> AsyncIterator[bytes]:
    conn: asyncssh.SSHClientConnection | None = None
    try:
        try:
            conn = await connect_sam_desktop()
        except OSError as e:
            yield _sse(json.dumps({"type": "error", "message": str(e)}))
            return
        exit_c: int | None = None
        async for text, code in iter_ssh_cmd_lines(conn, cmd):
            if text == "__end__":
                exit_c = code
                break
            yield _sse(json.dumps({"type": "log", "line": text}))
        if exit_c is None or exit_c != 0:
            yield _sse(
                json.dumps(
                    {
                        "type": "error",
                        "message": f"Command exited with code {exit_c if exit_c is not None else -1}",
                    }
                )
            )
            return
        yield _sse(json.dumps({"type": "done", "success": True}))
    finally:
        if conn:
            conn.close()
            await conn.wait_closed()


async def _nssm_env_apply_gen(body: NssmEnvBody) -> AsyncIterator[bytes]:
    pairs = _pairs_from_body(body)
    cmd = _nssm_set_env_ps(pairs)
    async for chunk in _stream_ssh_cmd(cmd):
        yield chunk


@router.post("/nssm-env", dependencies=[Depends(require_admin)])
async def post_nssm_env(body: NssmEnvBody):
    return StreamingResponse(
        _nssm_env_apply_gen(body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _restart_ollama_gen() -> AsyncIterator[bytes]:
    cmd = _nssm_action_ps("restart")
    conn: asyncssh.SSHClientConnection | None = None
    try:
        try:
            conn = await connect_sam_desktop()
        except OSError as e:
            yield _sse(json.dumps({"type": "error", "message": str(e)}))
            return
        exit_c: int | None = None
        async for text, code in iter_ssh_cmd_lines(conn, cmd):
            if text == "__end__":
                exit_c = code
                break
            yield _sse(json.dumps({"type": "log", "line": text}))
        if exit_c is None or exit_c != 0:
            yield _sse(
                json.dumps(
                    {
                        "type": "error",
                        "message": f"Command exited with code {exit_c if exit_c is not None else -1}",
                    }
                )
            )
            return

        base = _ollama_base()
        deadline = time.monotonic() + 15.0
        version_str = ""
        while time.monotonic() < deadline:
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(2.0)) as client:
                    vr = await client.get(f"{base}/api/version")
                    if vr.status_code == 200:
                        vdata = vr.json()
                        if isinstance(vdata, dict):
                            version_str = str(vdata.get("version") or "").strip()
                        yield _sse(
                            json.dumps(
                                {
                                    "type": "done",
                                    "success": True,
                                    "ollama_version": version_str or None,
                                }
                            )
                        )
                        return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.5)

        yield _sse(
            json.dumps(
                {"type": "error", "message": "Ollama did not come back up within 15 seconds"}
            )
        )
    finally:
        if conn:
            conn.close()
            await conn.wait_closed()


@router.post("/restart-ollama", dependencies=[Depends(require_admin)])
async def restart_ollama():
    return StreamingResponse(
        _restart_ollama_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _simple_nssm_action_gen(action: str) -> AsyncIterator[bytes]:
    cmd = _nssm_action_ps(action)
    async for chunk in _stream_ssh_cmd(cmd):
        yield chunk


@router.post("/stop-ollama", dependencies=[Depends(require_admin)])
async def stop_ollama():
    return StreamingResponse(
        _simple_nssm_action_gen("stop"),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/start-ollama", dependencies=[Depends(require_admin)])
async def start_ollama():
    return StreamingResponse(
        _simple_nssm_action_gen("start"),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _normalize_service_status(raw: str, exit_code: int) -> str:
    s = (raw or "").strip()
    low = s.lower()
    if exit_code != 0 and not s:
        return "Unknown"
    if "running" in low or "service_running" in low or "started" in low:
        return "Running"
    if "stopped" in low or "service_stopped" in low:
        return "Stopped"
    if "paused" in low or "pause" in low:
        return "Stopped"
    if not s:
        return "Unknown"
    return "Unknown"


@router.get("/ollama-service-status")
async def ollama_service_status():
    conn: asyncssh.SSHClientConnection | None = None
    raw_combined = ""
    try:
        try:
            conn = await connect_sam_desktop()
        except OSError as e:
            return {"status": "Unknown", "raw": "", "error": str(e)}
        inner = f"& '{NSSM_EXE}' status {OLLAMA_SERVICE}"
        cmd = "powershell -NoProfile -Command " + powershell_single_quote(inner)
        r = await conn.run(cmd, check=False, encoding="utf-8")
        out = (r.stdout or "").strip()
        err = (r.stderr or "").strip()
        raw_combined = out or err
        code = r.exit_status if r.exit_status is not None else -1
        status = _normalize_service_status(raw_combined, code)
        return {"status": status, "raw": raw_combined}
    finally:
        if conn:
            conn.close()
            await conn.wait_closed()
