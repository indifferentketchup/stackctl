"""Machine registry + framework control endpoints."""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import shlex
import time
from typing import Any

import aiosqlite
import httpx
import yaml
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_deps import require_admin
from config_backups import list_backups, read_backup, save_backup
from db import DB_PATH
from machines_ssh import (
    connect_for_machine,
    ssh_exec,
    ssh_read_file,
    ssh_stream_lines,
    ssh_write_file,
)
from routers.ollama import _sse

router = APIRouter()
_KEYS_DIR = pathlib.Path("/docker/stackctl/ssh/keys")
_SAFE_FILENAME = re.compile(r"^[a-zA-Z0-9_.-]+$")
_FRAMEWORKS = {"llama-swap", "tabbyapi", "ollama", "infinity-emb", "none"}
_OSES = {"windows", "ubuntu", "other"}
_OLLAMA_CMD_ALLOWLIST = {"pull", "rm", "list", "ps", "show", "stop", "start"}


class MachineCreate(BaseModel):
    name: str
    ip: str
    os: str = "ubuntu"
    ssh_user: str
    ssh_key_path: str | None = None
    prom_job: str | None = None
    gpu_prom_job: str | None = None
    framework: str = "none"
    framework_url: str | None = None
    framework_config_path: str | None = None
    framework_restart_cmd: str | None = None


class MachineUpdate(BaseModel):
    name: str | None = None
    ip: str | None = None
    os: str | None = None
    ssh_user: str | None = None
    ssh_key_path: str | None = None
    prom_job: str | None = None
    gpu_prom_job: str | None = None
    framework: str | None = None
    framework_url: str | None = None
    framework_config_path: str | None = None
    framework_restart_cmd: str | None = None


class SshKeyBody(BaseModel):
    filename: str
    content: str


class FrameworkConfigBody(BaseModel):
    yaml_text: str = Field(..., min_length=0)


class FrameworkModelBody(BaseModel):
    model: str = Field(..., min_length=1)


class OllamaCmdBody(BaseModel):
    cmd: str
    args: str = ""

def _prometheus_url() -> str:
    return (os.environ.get("PROMETHEUS_URL") or "http://100.114.205.53:9090").strip().rstrip("/")


def _sanitize_filename(name: str) -> str:
    base = pathlib.Path(name or "").name.strip()
    if not base or base.startswith(".") or not _SAFE_FILENAME.fullmatch(base):
        raise HTTPException(status_code=400, detail="Invalid filename")
    return base


def _row_public(row: aiosqlite.Row) -> dict[str, Any]:
    data = dict(row)
    data.pop("ssh_key_path", None)
    return data


def _validate_machine_fields(data: dict[str, Any]) -> None:
    os_value = data.get("os")
    if os_value is not None and str(os_value).strip().lower() not in _OSES:
        raise HTTPException(status_code=400, detail="Invalid os value")
    fw = data.get("framework")
    if fw is not None and str(fw).strip().lower() not in _FRAMEWORKS:
        raise HTTPException(status_code=400, detail="Invalid framework value")


async def _get_machine_row(machine_id: int) -> aiosqlite.Row:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM machines WHERE id = ?", (machine_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Machine not found")
    return row


async def _prom_query(client: httpx.AsyncClient, query: str) -> float | None:
    try:
        resp = await client.get(f"{_prometheus_url()}/api/v1/query", params={"query": query})
        payload = resp.json()
        result = (((payload or {}).get("data") or {}).get("result") or [])
        if not result:
            return None
        value = result[0].get("value") if isinstance(result[0], dict) else None
        if not isinstance(value, list) or len(value) < 2:
            return None
        return float(value[1])
    except Exception:
        return None


def _loaded_model_from_running_payload(payload: Any) -> str | None:
    if payload is None:
        return None
    if isinstance(payload, str):
        return payload.strip() or None
    if isinstance(payload, list):
        if not payload:
            return None
        first = payload[0]
        if isinstance(first, str):
            return first.strip() or None
        if isinstance(first, dict):
            for key in ("id", "model", "model_id", "name"):
                val = first.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
        return None
    if isinstance(payload, dict):
        for key in ("model", "current_model", "model_id", "id", "name"):
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        models = payload.get("models")
        if isinstance(models, list) and models:
            return _loaded_model_from_running_payload(models)
        running = payload.get("running")
        if running is not None and running is not payload:
            return _loaded_model_from_running_payload(running)
    return None


def _model_ids_from_config(text: str) -> list[str]:
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        return []
    models = data.get("models") if isinstance(data, dict) else None
    if isinstance(models, dict):
        return sorted([str(k) for k in models.keys()])
    return []


@router.get("")
async def list_machines(_owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM machines ORDER BY id") as cur:
            rows = await cur.fetchall()
    return {"machines": [_row_public(r) for r in rows]}


@router.post("")
async def create_machine(body: MachineCreate, _owner: dict = Depends(require_admin)):
    data = body.model_dump()
    _validate_machine_fields(data)
    data["os"] = str(data["os"]).strip().lower()
    data["framework"] = str(data["framework"]).strip().lower()
    if data.get("framework_url"):
        data["framework_url"] = str(data["framework_url"]).strip().rstrip("/")
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        try:
            cur = await db.execute(
                """
                INSERT INTO machines
                (name, ip, os, ssh_user, ssh_key_path, prom_job, gpu_prom_job, framework, framework_url, framework_config_path, framework_restart_cmd)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data["name"],
                    data["ip"],
                    data["os"],
                    data["ssh_user"],
                    data["ssh_key_path"],
                    data["prom_job"],
                    data["gpu_prom_job"],
                    data["framework"],
                    data["framework_url"],
                    data["framework_config_path"],
                    data["framework_restart_cmd"],
                ),
            )
            await db.commit()
            machine_id = int(cur.lastrowid)
        except aiosqlite.IntegrityError as e:
            raise HTTPException(status_code=409, detail="Machine name already exists") from e
    row = await _get_machine_row(machine_id)
    return _row_public(row)


@router.post("/ssh-keys")
async def upload_ssh_key(
    request: Request,
    _owner: dict = Depends(require_admin),
    file: UploadFile | None = File(default=None),
):
    filename: str
    content: bytes
    if file is not None:
        filename = file.filename or ""
        content = await file.read()
    else:
        payload = SshKeyBody(**(await request.json()))
        filename = payload.filename
        content = payload.content.encode("utf-8")

    safe = _sanitize_filename(filename)
    _KEYS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = (_KEYS_DIR / safe).resolve()
    if _KEYS_DIR.resolve() not in out_path.parents:
        raise HTTPException(status_code=400, detail="Invalid filename path")
    out_path.write_bytes(content)
    os.chmod(out_path, 0o600)
    return {"path": str(out_path)}


@router.get("/{machine_id}")
async def get_machine(machine_id: int, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    return _row_public(row)


@router.put("/{machine_id}")
async def update_machine(machine_id: int, body: MachineUpdate, _owner: dict = Depends(require_admin)):
    updates = body.model_dump(exclude_unset=True)
    _validate_machine_fields(updates)
    if "os" in updates:
        updates["os"] = str(updates["os"]).strip().lower()
    if "framework" in updates:
        updates["framework"] = str(updates["framework"]).strip().lower()
    if "framework_url" in updates and updates["framework_url"] is not None:
        updates["framework_url"] = str(updates["framework_url"]).strip().rstrip("/")
    if not updates:
        row = await _get_machine_row(machine_id)
        return _row_public(row)
    await _get_machine_row(machine_id)
    cols = ", ".join([f"{k} = ?" for k in updates.keys()])
    values = list(updates.values()) + [machine_id]
    async with aiosqlite.connect(DB_PATH) as db:
        try:
            await db.execute(f"UPDATE machines SET {cols} WHERE id = ?", values)
            await db.commit()
        except aiosqlite.IntegrityError as e:
            raise HTTPException(status_code=409, detail="Machine name already exists") from e
    row = await _get_machine_row(machine_id)
    return _row_public(row)


@router.delete("/{machine_id}")
async def delete_machine(machine_id: int, _owner: dict = Depends(require_admin)):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM machines WHERE id = ?", (machine_id,))
        await db.commit()
    return {"ok": True}


@router.get("/{machine_id}/status")
async def machine_status(machine_id: int, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    prom_job = str(row["prom_job"] or "").strip()
    gpu_prom_job = str(row["gpu_prom_job"] or "").strip()
    os_name = str(row["os"] or "ubuntu").strip().lower()
    if not prom_job:
        return {"cpu_pct": None, "ram_pct": None, "ram_total_gb": None, "disk_pct": None, "gpu": None}

    if os_name in ("ubuntu", "other"):
        queries = {
            "cpu_pct": f'100 - (avg by(instance)(rate(node_cpu_seconds_total{{job="{prom_job}",mode="idle"}}[2m])) * 100)',
            "ram_pct": f'(node_memory_MemTotal_bytes{{job="{prom_job}"}} - node_memory_MemAvailable_bytes{{job="{prom_job}"}}) / node_memory_MemTotal_bytes{{job="{prom_job}"}} * 100',
            "ram_total_gb": f'node_memory_MemTotal_bytes{{job="{prom_job}"}} / 1073741824',
            "disk_pct": f'(node_filesystem_size_bytes{{job="{prom_job}",mountpoint="/"}} - node_filesystem_avail_bytes{{job="{prom_job}",mountpoint="/"}}) / node_filesystem_size_bytes{{job="{prom_job}",mountpoint="/"}} * 100',
        }
    else:
        queries = {
            "cpu_pct": f'100 - (avg(rate(windows_cpu_time_total{{job="{prom_job}",mode="idle"}}[2m])) * 100)',
            "ram_pct": f'(windows_cs_physical_memory_bytes{{job="{prom_job}"}} - windows_memory_available_bytes{{job="{prom_job}"}}) / windows_cs_physical_memory_bytes{{job="{prom_job}"}} * 100',
            "ram_total_gb": f'windows_cs_physical_memory_bytes{{job="{prom_job}"}} / 1073741824',
            "disk_pct": f'(windows_logical_disk_size_bytes{{job="{prom_job}",volume="C:"}} - windows_logical_disk_free_bytes{{job="{prom_job}",volume="C:"}}) / windows_logical_disk_size_bytes{{job="{prom_job}",volume="C:"}} * 100',
        }

    gpu_queries: dict[str, str] = {}
    if gpu_prom_job:
        if "dcgm" in gpu_prom_job.lower():
            gpu_queries = {
                "vram_used_bytes": f'DCGM_FI_DEV_FB_USED{{job="{gpu_prom_job}"}} * 1048576',
                "vram_total_bytes": f'(DCGM_FI_DEV_FB_USED{{job="{gpu_prom_job}"}} + DCGM_FI_DEV_FB_FREE{{job="{gpu_prom_job}"}}) * 1048576',
                "util_pct": f'DCGM_FI_DEV_GPU_UTIL{{job="{gpu_prom_job}"}}',
                "temp_c": f'DCGM_FI_DEV_GPU_TEMP{{job="{gpu_prom_job}"}}',
            }
        else:
            gpu_queries = {
                "vram_used_bytes": f'nvidia_smi_memory_used_bytes{{job="{gpu_prom_job}"}}',
                "vram_total_bytes": f'nvidia_smi_memory_total_bytes{{job="{gpu_prom_job}"}}',
                "util_pct": f'nvidia_smi_utilization_gpu_ratio{{job="{gpu_prom_job}"}} * 100',
                "temp_c": f'nvidia_smi_temperature_gpu{{job="{gpu_prom_job}"}}',
            }

    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
        metric_keys = list(queries.keys()) + list(gpu_queries.keys())
        metric_queries = list(queries.values()) + list(gpu_queries.values())
        metric_values = await asyncio.gather(*[_prom_query(client, q) for q in metric_queries])
    mapped = dict(zip(metric_keys, metric_values))
    gpu = None
    if gpu_prom_job:
        gpu = {
            "vram_used_bytes": mapped.get("vram_used_bytes"),
            "vram_total_bytes": mapped.get("vram_total_bytes"),
            "util_pct": mapped.get("util_pct"),
            "temp_c": mapped.get("temp_c"),
        }
    return {
        "cpu_pct": mapped.get("cpu_pct"),
        "ram_pct": mapped.get("ram_pct"),
        "ram_total_gb": mapped.get("ram_total_gb"),
        "disk_pct": mapped.get("disk_pct"),
        "gpu": gpu,
    }


@router.get("/{machine_id}/health")
async def machine_health(machine_id: int, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    base = str(row["framework_url"] or "").strip().rstrip("/")
    if not base:
        return {"ok": False, "status_code": None, "latency_ms": None}
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            r = await client.get(f"{base}/health")
            if r.status_code == 404:
                r = await client.get(f"{base}/v1/models")
        latency_ms = (time.perf_counter() - start) * 1000.0
        return {"ok": r.status_code < 400, "status_code": r.status_code, "latency_ms": latency_ms}
    except Exception:
        return {"ok": False, "status_code": None, "latency_ms": None}


@router.get("/{machine_id}/ssh")
async def machine_ssh_check(machine_id: int, _owner: dict = Depends(require_admin)):
    try:
        out, _err, code = await asyncio.wait_for(ssh_exec(machine_id, "echo stackctl-ok"), timeout=10.0)
        ok = code == 0 and "stackctl-ok" in (out or "")
        return {"ok": ok, "error": None if ok else "ssh command failed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/{machine_id}/framework/config")
async def framework_config_get(machine_id: int, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    path = str(row["framework_config_path"] or "").strip()
    if not path:
        raise HTTPException(status_code=503, detail="framework_config_path is not set")
    conn = await connect_for_machine(machine_id)
    try:
        yaml_text = await ssh_read_file(conn, path)
    finally:
        conn.close()
    return {"path": path, "yaml_text": yaml_text}


@router.put("/{machine_id}/framework/config")
async def framework_config_put(machine_id: int, body: FrameworkConfigBody, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    path = str(row["framework_config_path"] or "").strip()
    restart_cmd = str(row["framework_restart_cmd"] or "").strip()
    if not path or not restart_cmd:
        raise HTTPException(status_code=503, detail="framework_config_path/framework_restart_cmd is not set")
    try:
        yaml.safe_load(body.yaml_text or "")
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}") from e
    conn = await connect_for_machine(machine_id)
    try:
        try:
            current_content = await ssh_read_file(conn, path)
        except Exception:
            current_content = None
        if current_content is not None:
            await save_backup(int(row["id"]), str(row["name"]), path, current_content)
        await ssh_write_file(conn, path, body.yaml_text)
    finally:
        conn.close()
    _out, err, code = await ssh_exec(machine_id, restart_cmd)
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Restart failed: {(err or '')[:2000]}")
    return {"ok": True, "path": path}


@router.get("/{machine_id}/framework/config/backups")
async def framework_config_backups_list(machine_id: int, _owner: dict = Depends(require_admin)):
    await _get_machine_row(machine_id)
    backups = await list_backups(machine_id)
    return {"backups": backups}


@router.get("/{machine_id}/framework/config/backups/{bid}")
async def framework_config_backup_get(machine_id: int, bid: str, _owner: dict = Depends(require_admin)):
    await _get_machine_row(machine_id)
    try:
        content = await read_backup(machine_id, bid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Backup not found") from e
    return {"id": bid, "yaml_text": content}


@router.post("/{machine_id}/framework/config/backups/{bid}/restore")
async def framework_config_backup_restore(machine_id: int, bid: str, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    path = str(row["framework_config_path"] or "").strip()
    restart_cmd = str(row["framework_restart_cmd"] or "").strip()
    if not path or not restart_cmd:
        raise HTTPException(status_code=503, detail="framework_config_path/framework_restart_cmd is not set")
    try:
        content = await read_backup(machine_id, bid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Backup not found") from e

    conn = await connect_for_machine(machine_id)
    try:
        try:
            current_content = await ssh_read_file(conn, path)
        except Exception:
            current_content = None
        if current_content is not None:
            await save_backup(int(row["id"]), str(row["name"]), path, current_content)
        await ssh_write_file(conn, path, content)
    finally:
        conn.close()
    _out, err, code = await ssh_exec(machine_id, restart_cmd)
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Restart failed: {(err or '')[:2000]}")
    return {"ok": True, "restored_id": bid}


@router.post("/{machine_id}/framework/restart")
async def framework_restart(machine_id: int, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    restart_cmd = str(row["framework_restart_cmd"] or "").strip()
    if not restart_cmd:
        raise HTTPException(status_code=503, detail="framework_restart_cmd is not set")
    _out, err, code = await ssh_exec(machine_id, restart_cmd)
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Restart failed: {(err or '')[:2000]}")
    return {"ok": True}


@router.get("/{machine_id}/framework/running")
async def framework_running(machine_id: int, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    base = str(row["framework_url"] or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="framework_url is not set")
    async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
        resp = await client.get(f"{base}/running")
    try:
        payload: Any = resp.json()
    except Exception:
        payload = {"raw": (resp.text or "")[:4000]}
    return {"loaded_model": _loaded_model_from_running_payload(payload), "raw": payload}


@router.post("/{machine_id}/framework/warm")
async def framework_warm(machine_id: int, body: FrameworkModelBody, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    base = str(row["framework_url"] or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="framework_url is not set")
    url = f"{base}/v1/chat/completions"
    payload = {
        "model": body.model.strip(),
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "stream": True,
    }
    timeout = httpx.Timeout(60.0, connect=15.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, json=payload) as resp:
            if resp.status_code >= 400:
                raw = await resp.aread()
                raise HTTPException(status_code=502, detail=raw.decode("utf-8", errors="replace")[:2000])
            async for _ in resp.aiter_bytes():
                pass
    return {"ok": True}


@router.post("/{machine_id}/framework/unload")
async def framework_unload(machine_id: int, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    base = str(row["framework_url"] or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="framework_url is not set")
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        resp = await client.post(f"{base}/models/unload", json={})
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Unload HTTP {resp.status_code}")
    return {"ok": True}


async def internal_framework_models(machine_id: int) -> dict[str, Any]:
    """Same behavior as GET /{machine_id}/framework/models (no HTTP)."""
    row = await _get_machine_row(machine_id)
    framework = str(row["framework"] or "none").strip().lower()
    base = str(row["framework_url"] or "").strip().rstrip("/")
    config_path = str(row["framework_config_path"] or "").strip()

    if framework == "llama-swap":
        if not config_path:
            return {"models": []}
        conn = await connect_for_machine(machine_id)
        try:
            text = await ssh_read_file(conn, config_path)
        finally:
            conn.close()
        return {"models": _model_ids_from_config(text)}

    if framework == "tabbyapi":
        names: set[str] = set()
        model_dir = "/docker/tabbyapi/models"
        if config_path:
            model_dir = str(pathlib.PurePosixPath(config_path).parent) or model_dir
        out, _err, code = await ssh_exec(machine_id, f"ls {shlex.quote(model_dir)}")
        if code == 0:
            for line in (out or "").splitlines():
                stem = pathlib.Path(line.strip()).stem.strip()
                if stem:
                    names.add(stem)
        if base:
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
                    resp = await client.get(f"{base}/v1/models")
                payload = resp.json() if resp.status_code < 400 else {}
                data = payload.get("data") if isinstance(payload, dict) else None
                if isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict):
                            val = (item.get("id") or item.get("name") or "").strip()
                            if val:
                                names.add(val)
            except Exception:
                pass
        return {"models": sorted(names)}

    if framework == "ollama" and base:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
                resp = await client.get(f"{base}/api/tags")
            payload = resp.json() if resp.status_code < 400 else {}
            models = payload.get("models") if isinstance(payload, dict) else None
            if isinstance(models, list):
                return {
                    "models": sorted(
                        [str(m.get("name")).strip() for m in models if isinstance(m, dict) and str(m.get("name") or "").strip()]
                    )
                }
        except Exception:
            pass
    return {"models": []}


@router.get("/{machine_id}/framework/models")
async def framework_models(machine_id: int, _owner: dict = Depends(require_admin)):
    return await internal_framework_models(machine_id)


@router.post("/{machine_id}/framework/tabby/load")
async def tabby_load(machine_id: int, body: FrameworkModelBody, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    base = str(row["framework_url"] or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="framework_url is not set")
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        resp = await client.post(f"{base}/v1/model/load", json={"name": body.model.strip()})
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Tabby load failed: HTTP {resp.status_code}")
    return {"ok": True}


@router.post("/{machine_id}/framework/tabby/unload")
async def tabby_unload(machine_id: int, _owner: dict = Depends(require_admin)):
    row = await _get_machine_row(machine_id)
    base = str(row["framework_url"] or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="framework_url is not set")
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        resp = await client.post(f"{base}/v1/model/unload", json={})
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Tabby unload failed: HTTP {resp.status_code}")
    return {"ok": True}


@router.post("/{machine_id}/framework/ollama/cmd")
async def ollama_cmd(machine_id: int, body: OllamaCmdBody, _owner: dict = Depends(require_admin)):
    cmd = (body.cmd or "").strip().lower()
    if cmd not in _OLLAMA_CMD_ALLOWLIST:
        raise HTTPException(status_code=400, detail="Invalid ollama cmd")

    args_parts = shlex.split(body.args or "")
    quoted_args = " ".join(shlex.quote(p) for p in args_parts)
    full_cmd = f"ollama {cmd}" + (f" {quoted_args}" if quoted_args else "")

    async def gen():
        try:
            async for line, end in ssh_stream_lines(machine_id, full_cmd):
                if line == "__end__":
                    yield _sse(json.dumps({"done": True, "exit_code": int(end or -1)}))
                else:
                    yield _sse(json.dumps({"line": line}))
        except Exception as e:
            yield _sse(json.dumps({"done": True, "exit_code": -1, "error": str(e)}))

    return StreamingResponse(gen(), media_type="text/event-stream")
