"""GPU / Ollama environment config — status from Ollama APIs, desired config SQLite, NSSM or systemd via SSH."""

from __future__ import annotations

import asyncio
import json
import re
import shlex
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import aiosqlite
import asyncssh
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_deps import require_admin
from db import DB_PATH
from machine_queries import machine_row
from sam_ssh import (
    connect_sam_desktop,
    connect_ssh,
    iter_ssh_cmd_lines,
    nssm_cmd_get_app_environment_extra,
    nssm_cmd_service_action,
    nssm_cmd_set_app_environment_extra,
    sam_desktop_host,
    sam_desktop_user,
    ssh_remove_file,
    ssh_write_file,
)
from routers.ollama import _ollama_base, _sse

router = APIRouter()

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


async def _gpu_machine_for(machine_id: int | None) -> dict[str, Any]:
    if machine_id is None:
        return {
            "id": None,
            "name": "sam-desktop",
            "ollama_url": _ollama_base(),
            "ssh_host": sam_desktop_host(),
            "ssh_user": sam_desktop_user(),
            "ssh_type": "nssm",
        }
    row = await machine_row(machine_id)
    if not row:
        raise HTTPException(status_code=404, detail="Machine not found")
    return row


async def _connect_for_gpu_machine(m: dict[str, Any]) -> asyncssh.SSHClientConnection:
    if m.get("id") is None:
        return await connect_sam_desktop()
    h = (m.get("ssh_host") or "").strip()
    u = (m.get("ssh_user") or "").strip()
    if not h or not u:
        raise OSError("Machine has no SSH host/user configured")
    return await connect_ssh(h, u)


def _parse_systemd_environment(stdout: str) -> dict[str, str]:
    raw = (stdout or "").strip()
    if not raw or raw == "-":
        return {}
    if raw.startswith("Environment="):
        raw = raw[len("Environment=") :].strip()
    try:
        parts = shlex.split(raw)
    except ValueError:
        parts = raw.split()
    env: dict[str, str] = {}
    for p in parts:
        if "=" in p:
            k, _, v = p.partition("=")
            k, v = k.strip(), v.strip().strip('"')
            if k:
                env[k] = v
    return env


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
async def gpu_status(machine_id: int | None = Query(None)):
    m = await _gpu_machine_for(machine_id)
    base = str(m["ollama_url"]).rstrip("/")
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
        "machine_id": m.get("id"),
        "machine_name": m.get("name"),
        "ssh_type": m.get("ssh_type"),
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


@router.get("/nssm-env", dependencies=[Depends(require_admin)])
async def get_nssm_env(machine_id: int | None = Query(None)):
    m = await _gpu_machine_for(machine_id)
    conn: asyncssh.SSHClientConnection | None = None
    try:
        try:
            conn = await _connect_for_gpu_machine(m)
        except OSError as e:
            return {"env": {}, "error": str(e)}
        st = str(m.get("ssh_type") or "nssm").lower()
        if st == "systemd":
            r = await conn.run(
                "sudo -n systemctl show ollama -p Environment --value",
                check=False,
                encoding="utf-8",
            )
            code = r.exit_status if r.exit_status is not None else -1
            if code != 0:
                msg = ((r.stderr or r.stdout or "").strip() or f"systemctl exited with code {code}")[:2000]
                return {"env": {}, "error": msg}
            parsed = _parse_systemd_environment(r.stdout or "")
            env = {k: parsed.get(k, "") for k in NSSM_FORM_KEYS}
            return {"env": env, "raw": (r.stdout or "").strip()}
        r = await conn.run(nssm_cmd_get_app_environment_extra(), check=False, encoding="utf-8")
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


async def _stream_ssh_cmd_for_machine(m: dict[str, Any], cmd: str) -> AsyncIterator[bytes]:
    conn: asyncssh.SSHClientConnection | None = None
    try:
        try:
            conn = await _connect_for_gpu_machine(m)
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


async def _systemd_dropin_apply_gen(body: NssmEnvBody, m: dict[str, Any]) -> AsyncIterator[bytes]:
    pairs = _pairs_from_body(body)
    content = "[Service]\n" + "\n".join(f"Environment={p}" for p in pairs) + "\n"
    conn: asyncssh.SSHClientConnection | None = None
    tmp = f"/tmp/ollamactl_override_{uuid.uuid4().hex}.conf"
    qtmp = shlex.quote(tmp)
    try:
        try:
            conn = await _connect_for_gpu_machine(m)
        except OSError as e:
            yield _sse(json.dumps({"type": "error", "message": str(e)}))
            return
        await ssh_write_file(conn, tmp, content)
        cmd = (
            f"sudo mkdir -p /etc/systemd/system/ollama.service.d && "
            f"sudo mv {qtmp} /etc/systemd/system/ollama.service.d/99-ollamactl.conf && "
            f"sudo chmod 644 /etc/systemd/system/ollama.service.d/99-ollamactl.conf && "
            f"sudo systemctl daemon-reload"
        )
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
                        "message": f"systemd drop-in failed with code {exit_c if exit_c is not None else -1}",
                    }
                )
            )
            return
        yield _sse(json.dumps({"type": "done", "success": True}))
    finally:
        if conn:
            try:
                await ssh_remove_file(conn, tmp)
            except (OSError, asyncssh.Error):
                pass
            conn.close()
            await conn.wait_closed()


async def _nssm_env_apply_gen(body: NssmEnvBody, m: dict[str, Any]) -> AsyncIterator[bytes]:
    st = str(m.get("ssh_type") or "nssm").lower()
    if st == "systemd":
        async for chunk in _systemd_dropin_apply_gen(body, m):
            yield chunk
        return
    pairs = _pairs_from_body(body)
    cmd = nssm_cmd_set_app_environment_extra(pairs)
    async for chunk in _stream_ssh_cmd_for_machine(m, cmd):
        yield chunk


@router.post("/nssm-env", dependencies=[Depends(require_admin)])
async def post_nssm_env(body: NssmEnvBody, machine_id: int | None = Query(None)):
    m = await _gpu_machine_for(machine_id)
    return StreamingResponse(
        _nssm_env_apply_gen(body, m),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _restart_ollama_gen(m: dict[str, Any]) -> AsyncIterator[bytes]:
    st = str(m.get("ssh_type") or "nssm").lower()
    if st == "systemd":
        cmd = "sudo -n systemctl restart ollama"
    else:
        cmd = nssm_cmd_service_action("restart")
    conn: asyncssh.SSHClientConnection | None = None
    try:
        try:
            conn = await _connect_for_gpu_machine(m)
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

        base = str(m["ollama_url"]).rstrip("/")
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
async def restart_ollama(machine_id: int | None = Query(None)):
    m = await _gpu_machine_for(machine_id)
    return StreamingResponse(
        _restart_ollama_gen(m),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _simple_service_action_gen(action: str, m: dict[str, Any]) -> AsyncIterator[bytes]:
    st = str(m.get("ssh_type") or "nssm").lower()
    if st == "systemd":
        cmd = f"sudo -n systemctl {action} ollama"
        async for chunk in _stream_ssh_cmd_for_machine(m, cmd):
            yield chunk
        return
    cmd = nssm_cmd_service_action(action)
    async for chunk in _stream_ssh_cmd_for_machine(m, cmd):
        yield chunk


@router.post("/stop-ollama", dependencies=[Depends(require_admin)])
async def stop_ollama(machine_id: int | None = Query(None)):
    m = await _gpu_machine_for(machine_id)
    return StreamingResponse(
        _simple_service_action_gen("stop", m),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/start-ollama", dependencies=[Depends(require_admin)])
async def start_ollama(machine_id: int | None = Query(None)):
    m = await _gpu_machine_for(machine_id)
    return StreamingResponse(
        _simple_service_action_gen("start", m),
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
async def ollama_service_status(machine_id: int | None = Query(None)):
    m = await _gpu_machine_for(machine_id)
    conn: asyncssh.SSHClientConnection | None = None
    raw_combined = ""
    try:
        try:
            conn = await _connect_for_gpu_machine(m)
        except OSError as e:
            return {"status": "Unknown", "raw": "", "error": str(e)}
        st = str(m.get("ssh_type") or "nssm").lower()
        if st == "systemd":
            r = await conn.run("sudo -n systemctl is-active ollama", check=False, encoding="utf-8")
            out = (r.stdout or "").strip().lower()
            raw_combined = ((r.stdout or "") + (r.stderr or "")).strip()
            if out == "active":
                status = "Running"
            elif out in ("inactive", "failed"):
                status = "Stopped"
            else:
                status = "Unknown"
            return {"status": status, "raw": raw_combined}
        r = await conn.run(nssm_cmd_service_action("status"), check=False, encoding="utf-8")
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
