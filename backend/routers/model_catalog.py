"""Aggregated model catalog across machines + Bifrost."""

from __future__ import annotations

import asyncio
import os
import re
import shlex
import time
from typing import Any

import aiosqlite
import httpx
import yaml
from fastapi import APIRouter, Depends

from auth_deps import require_admin
from db import DB_PATH
from machines_ssh import connect_for_machine, ssh_exec, ssh_read_file
from routers.machines import (
    _loaded_model_from_running_payload,
    _model_ids_from_config,
    internal_framework_models,
)

router = APIRouter()

_CONFIG_LOCK = asyncio.Lock()
_CONFIG_CACHE: dict[tuple[int, str], tuple[float, str]] = {}

_STAT_LOCK = asyncio.Lock()
_STAT_CACHE: dict[str, tuple[float, int | None]] = {}

_QUANT_PATTERNS = re.compile(
    r"(EXL[23]|IQ\d+(?:_[A-Z0-9]+)?|Q\d+(?:_[A-Z0-9]+)?|Q[48]_\d)",
    re.IGNORECASE,
)
_PARAM_RE = re.compile(
    r"(?P<n>\d+(?:\.\d+)?)\s*(?P<u>[bB])",
    re.IGNORECASE,
)


def _bifrost_base_url() -> str | None:
    u = (os.environ.get("BIFROST_URL") or "").strip().rstrip("/")
    return u or None


async def _list_catalog_machines() -> list[aiosqlite.Row]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT * FROM machines
            WHERE framework IS NOT NULL
              AND lower(trim(framework)) != 'none'
              AND framework_url IS NOT NULL
              AND trim(framework_url) != ''
            ORDER BY id
            """
        ) as cur:
            rows = await cur.fetchall()
    return list(rows)


async def _read_config_yaml_cached(machine_id: int, config_path: str) -> str | None:
    key = (machine_id, config_path)
    now = time.monotonic()
    async with _CONFIG_LOCK:
        hit = _CONFIG_CACHE.get(key)
        if hit and now - hit[0] < 60.0:
            return hit[1]
    try:
        conn = await connect_for_machine(machine_id)
        try:
            text = await ssh_read_file(conn, config_path)
        finally:
            conn.close()
    except Exception:
        return None
    async with _CONFIG_LOCK:
        _CONFIG_CACHE[key] = (now, text)
    return text


def _llama_model_cmds_from_yaml(text: str) -> dict[str, str]:
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        return {}
    models = data.get("models") if isinstance(data, dict) else None
    out: dict[str, str] = {}
    if not isinstance(models, dict):
        return out
    for k, v in models.items():
        cmd = ""
        if isinstance(v, dict):
            cmd = str(v.get("cmd") or v.get("command") or "")
        out[str(k)] = cmd
    return out


def _parse_m_path(cmd: str) -> str | None:
    if not cmd:
        return None
    m = re.search(r'(?:^|\s)-m\s+(?:"([^"]+)"|\'([^\']+)\'|(\S+))', cmd)
    if not m:
        return None
    return (m.group(1) or m.group(2) or m.group(3) or "").strip() or None


def _parse_ctx_from_cmd(cmd: str) -> int | None:
    if not cmd:
        return None
    for pat in (
        r"(?:^|\s)-c\s+(\d+)",
        r"(?:^|\s)--ctx-size\s+(\d+)",
        r"(?:^|\s)--context-length\s+(\d+)",
    ):
        m = re.search(pat, cmd)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                return None
    return None


def _quant_from_text(text: str) -> str | None:
    if not text:
        return None
    m = _QUANT_PATTERNS.search(text.replace("-", "_"))
    if not m:
        return None
    return m.group(1).upper().replace("__", "_")


def _param_billions_from_text(text: str) -> float | None:
    if not text:
        return None
    m = _PARAM_RE.search(text)
    if m:
        try:
            n = float(m.group("n"))
            u = m.group("u").lower()
            if u == "b":
                return n
        except ValueError:
            return None
    low = text.lower()
    for token in sorted(
        ("405b", "70b", "65b", "34b", "32b", "30b", "27b", "22b", "20b", "14b", "13b", "12b", "11b", "9b", "8b", "7b", "4b", "3b", "2b", "1b"),
        key=len,
        reverse=True,
    ):
        if token in low:
            try:
                return float(token[:-1])
            except ValueError:
                pass
    return None


def _estimate_bytes_from_quant(quant: str | None, param_b: float | None) -> int | None:
    if param_b is None or param_b <= 0:
        return None
    q = (quant or "").upper().replace("-", "_")
    gb_per_b = 0.7
    if "Q8" in q or "Q8_0" in q:
        gb_per_b = 1.0
    elif "Q6" in q:
        gb_per_b = 0.78
    elif "Q4_K_M" in q or "Q4KM" in q:
        gb_per_b = 0.67
    elif "Q4_K_XL" in q or "Q4KXL" in q:
        gb_per_b = 0.72
    elif "Q4" in q:
        gb_per_b = 0.62
    elif "Q3" in q:
        gb_per_b = 0.52
    elif "Q2" in q:
        gb_per_b = 0.38
    elif "EXL" in q:
        gb_per_b = 0.55
    elif "IQ" in q:
        gb_per_b = 0.58
    return int(param_b * gb_per_b * 1_000_000_000.0)


async def _stat_remote_file_bytes_cached(machine_id: int, remote_path: str, os_name: str) -> int | None:
    rp = (remote_path or "").strip()
    if not rp:
        return None
    cache_key = f"{machine_id}|{rp}"
    now = time.monotonic()
    async with _STAT_LOCK:
        hit = _STAT_CACHE.get(cache_key)
        if hit and now - hit[0] < 300.0:
            return hit[1]
    osn = (os_name or "ubuntu").strip().lower()
    size: int | None = None
    try:
        if osn == "windows":
            esc = rp.replace("'", "''")
            cmd = f'powershell -NoProfile -Command "(Get-Item -LiteralPath ''{esc}'').Length"'
            out, _err, code = await ssh_exec(machine_id, cmd)
            if code == 0 and (out or "").strip().isdigit():
                size = int((out or "").strip())
        else:
            out, _err, code = await ssh_exec(machine_id, f"stat -c %s -- {shlex.quote(rp)}")
            if code == 0 and (out or "").strip().isdigit():
                size = int((out or "").strip())
    except Exception:
        size = None
    async with _STAT_LOCK:
        _STAT_CACHE[cache_key] = (now, size)
    return size


async def _vram_llama_swap(
    machine_id: int,
    os_name: str,
    model_name: str,
    cmd: str,
    config_path: str,
    yaml_text: str | None,
) -> tuple[int | None, int | None, str | None]:
    quant = _quant_from_text(f"{model_name} {_parse_m_path(cmd) or ''}")
    ctx = _parse_ctx_from_cmd(cmd)
    mpath = _parse_m_path(cmd)
    param_b = _param_billions_from_text(f"{model_name} {mpath or ''}")

    stat_size: int | None = None
    if mpath:
        stat_size = await _stat_remote_file_bytes_cached(machine_id, mpath, os_name)

    if stat_size is not None:
        return stat_size, ctx, quant

    est = _estimate_bytes_from_quant(quant, param_b)
    return est, ctx, quant


async def _vram_tabby(machine_id: int, model_name: str) -> int | None:
    d = f"/docker/tabbyapi/models/{model_name}"
    try:
        out, _err, code = await ssh_exec(machine_id, f"du -sb {shlex.quote(d)} 2>/dev/null | awk '{{print $1}}'")
        if code == 0 and (out or "").strip().isdigit():
            return int((out or "").strip())
    except Exception:
        pass
    return None


def _ollama_find_size_bytes(obj: Any) -> int | None:
    if isinstance(obj, dict):
        for k in ("size", "Size"):
            v = obj.get(k)
            if isinstance(v, int) and v > 0:
                return v
            if isinstance(v, str) and v.isdigit():
                return int(v)
        for v in obj.values():
            found = _ollama_find_size_bytes(v)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _ollama_find_size_bytes(item)
            if found is not None:
                return found
    return None


async def _vram_ollama(base: str, model_name: str) -> int | None:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
            resp = await client.post(f"{base}/api/show", json={"name": model_name})
        payload = resp.json() if resp.status_code < 400 else {}
        if not isinstance(payload, dict):
            return None
        found = _ollama_find_size_bytes(payload)
        if found is not None:
            return found
    except Exception:
        pass
    return None


async def _noop_vram() -> None:
    return None


async def _fetch_bifrost_model_ids() -> list[str]:
    base = _bifrost_base_url()
    if not base:
        return []
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.get(f"{base}/v1/models")
        payload = r.json() if r.status_code < 400 else {}
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            return []
        out: list[str] = []
        for item in data:
            if isinstance(item, dict):
                mid = (item.get("id") or "").strip()
                if mid:
                    out.append(mid)
        return out
    except Exception:
        return []


async def _fetch_loaded_names(machine_id: int, framework: str, base: str) -> set[str]:
    loaded: set[str] = set()
    if not base:
        return loaded
    try:
        if framework == "llama-swap":
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
                resp = await client.get(f"{base}/running")
            payload = resp.json() if resp.status_code < 400 else {}
            lm = _loaded_model_from_running_payload(payload)
            if lm:
                loaded.add(lm)
        elif framework == "tabbyapi":
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
                resp = await client.get(f"{base}/v1/model")
            payload = resp.json() if resp.status_code < 400 else {}
            lm = _loaded_model_from_running_payload(payload)
            if lm:
                loaded.add(lm)
        elif framework == "ollama":
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
                resp = await client.get(f"{base}/api/ps")
            payload = resp.json() if resp.status_code < 400 else {}
            models = payload.get("models") if isinstance(payload, dict) else None
            if isinstance(models, list):
                for m in models:
                    if isinstance(m, dict):
                        n = str(m.get("name") or "").strip()
                        if n:
                            loaded.add(n)
    except Exception:
        pass
    return loaded


def _is_loaded_name(model_name: str, loaded: set[str]) -> bool:
    if not loaded:
        return False
    if model_name in loaded:
        return True
    mb = model_name.split(":")[0].strip()
    for r in loaded:
        if r == model_name:
            return True
        rb = r.split(":")[0].strip()
        if mb and rb and mb == rb:
            return True
    return False


async def _catalog_for_machine(row: aiosqlite.Row) -> list[dict[str, Any]]:
    machine_id = int(row["id"])
    machine_name = str(row["name"] or "").strip()
    framework = str(row["framework"] or "none").strip().lower()
    base = str(row["framework_url"] or "").strip().rstrip("/")
    config_path = str(row["framework_config_path"] or "").strip()
    os_name = str(row["os"] or "ubuntu").strip().lower()

    yaml_text: str | None = None
    cmds: dict[str, str] = {}
    names: list[str] = []

    if framework == "llama-swap":
        if config_path:
            yaml_text = await _read_config_yaml_cached(machine_id, config_path)
            if yaml_text is not None:
                names = _model_ids_from_config(yaml_text)
                cmds = _llama_model_cmds_from_yaml(yaml_text)
        loaded = await _fetch_loaded_names(machine_id, framework, base)
    else:
        fw_task = asyncio.create_task(internal_framework_models(machine_id))
        loaded_task = asyncio.create_task(_fetch_loaded_names(machine_id, framework, base))
        res = await asyncio.gather(fw_task, loaded_task, return_exceptions=True)
        if isinstance(res[0], Exception):
            return []
        if isinstance(res[1], Exception):
            loaded = set()
        else:
            loaded = res[1]
        raw = (res[0] or {}).get("models") or []
        names = list(raw) if isinstance(raw, list) else []

    out: list[dict[str, Any]] = []
    vram_tasks: list[Any] = []
    for nm in names:
        name = str(nm).strip()
        if not name:
            continue
        cmd = cmds.get(name, "")
        if framework == "llama-swap":
            vram_tasks.append(_vram_llama_swap(machine_id, os_name, name, cmd, config_path, yaml_text))
        elif framework == "tabbyapi":
            vram_tasks.append(_vram_tabby(machine_id, name))
        elif framework == "ollama":
            vram_tasks.append(_vram_ollama(base, name))
        else:
            vram_tasks.append(_noop_vram())

    vram_results = await asyncio.gather(*vram_tasks, return_exceptions=True)

    idx = 0
    for nm in names:
        name = str(nm).strip()
        if not name:
            continue
        cmd = cmds.get(name, "")
        vr: Any = vram_results[idx] if idx < len(vram_results) else None
        idx += 1
        vram_bytes: int | None = None
        ctx_size: int | None = None
        quant: str | None = None
        if framework == "llama-swap":
            if not isinstance(vr, Exception) and isinstance(vr, tuple) and len(vr) == 3:
                vram_bytes, ctx_size, quant = vr
            else:
                vram_bytes, ctx_size, quant = None, _parse_ctx_from_cmd(cmd), _quant_from_text(f"{name} {_parse_m_path(cmd) or ''}")
        elif framework == "tabbyapi":
            if not isinstance(vr, Exception):
                vram_bytes = vr if isinstance(vr, int) else None
        elif framework == "ollama":
            if not isinstance(vr, Exception):
                vram_bytes = vr if isinstance(vr, int) else None

        out.append(
            {
                "id": f"{machine_name}/{name}",
                "name": name,
                "machine_id": machine_id,
                "machine_name": machine_name,
                "framework": framework,
                "is_loaded": _is_loaded_name(name, loaded),
                "bifrost_id": None,
                "in_bifrost": False,
                "vram_bytes": vram_bytes,
                "ctx_size": ctx_size,
                "quant": quant,
                "source": framework,
                "cmd": cmd if framework == "llama-swap" else None,
            }
        )
    return out


def _apply_bifrost(models: list[dict[str, Any]], bifrost_ids: list[str]) -> None:
    lower_map = {b.lower(): b for b in bifrost_ids}
    for m in models:
        cand = f"{m['machine_name']}/{m['name']}"
        bid = lower_map.get(cand.lower())
        if bid:
            m["in_bifrost"] = True
            m["bifrost_id"] = bid
            m["id"] = bid
        else:
            m["in_bifrost"] = False
            m["bifrost_id"] = None


@router.get("/catalog", dependencies=[Depends(require_admin)])
async def model_catalog():
    machines = await _list_catalog_machines()
    results = await asyncio.gather(
        _fetch_bifrost_model_ids(),
        *[_catalog_for_machine(m) for m in machines],
        return_exceptions=True,
    )
    bifrost_ids: list[str] = []
    if results and not isinstance(results[0], Exception):
        bifrost_ids = results[0] if isinstance(results[0], list) else []
    models: list[dict[str, Any]] = []
    for r in results[1:]:
        if isinstance(r, Exception):
            continue
        if isinstance(r, list):
            models.extend(r)
    _apply_bifrost(models, bifrost_ids)
    return {"models": models}
