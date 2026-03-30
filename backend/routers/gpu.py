"""GPU / Ollama environment config — status from Ollama APIs, desired config in SQLite."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_deps import require_admin
from db import DB_PATH

router = APIRouter(dependencies=[Depends(require_admin)])

TRACKED_ENV_KEYS = (
    "CUDA_VISIBLE_DEVICES",
    "OLLAMA_GPU_LAYERS",
    "OLLAMA_MAX_LOADED_MODELS",
    "OLLAMA_KEEP_ALIVE",
    "OLLAMA_FLASH_ATTENTION",
    "OLLAMA_KV_CACHE_TYPE",
)


def _ollama_base() -> str:
    return os.environ.get("OLLAMA_URL", "http://100.101.41.16:11434").rstrip("/")


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


@router.get("/status")
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


@router.get("/config")
async def get_gpu_config():
    entries = await _all_config_rows()
    pending = await _pending_changes()
    config_map: dict[str, str] = {e["key"]: e["value"] for e in entries}
    return {"entries": entries, "config": config_map, "pending_changes": pending}


@router.put("/config")
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


@router.post("/mark-applied")
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
