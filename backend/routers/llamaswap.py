"""llama-swap: per-machine config over SSH + local HTTP to llama-swap."""

from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx
import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_deps import require_admin
from machines_ssh import (
    connect_for_machine,
    gpu_host,
    gpu_user,
    normalize_machine_id,
    sam_desktop_host,
    sam_desktop_user,
    ssh_exec as machine_ssh_exec,
    ssh_read_file,
    ssh_write_file,
)

router = APIRouter()


def _configured_machine_ids() -> set[str]:
    s: set[str] = set()
    if sam_desktop_host() and sam_desktop_user():
        s.add("sam-desktop")
    if gpu_host() and gpu_user():
        s.add("gpu")
    return s


def _llamaswap_config_path(machine_id: str) -> str:
    mid = normalize_machine_id(machine_id)
    if mid == "sam-desktop":
        p = (os.environ.get("SAMDESKTOP_LLAMASWAP_CONFIG") or "").strip()
    elif mid == "gpu":
        p = (os.environ.get("GPU_LLAMASWAP_CONFIG") or "").strip()
    else:
        raise HTTPException(status_code=404, detail="Unknown machine_id")
    if not p:
        raise HTTPException(status_code=503, detail=f"llama-swap config path not set for {mid}")
    return p


def _llamaswap_base_url(machine_id: str) -> str:
    mid = normalize_machine_id(machine_id)
    if mid == "sam-desktop":
        u = (os.environ.get("SAMDESKTOP_LLAMASWAP_URL") or "").strip().rstrip("/")
    elif mid == "gpu":
        u = (os.environ.get("GPU_LLAMASWAP_URL") or "").strip().rstrip("/")
    else:
        raise HTTPException(status_code=404, detail="Unknown machine_id")
    if not u:
        raise HTTPException(status_code=503, detail=f"llama-swap URL not set for {mid}")
    return u


def _restart_cmd(machine_id: str) -> str:
    mid = normalize_machine_id(machine_id)
    if mid == "sam-desktop":
        return (os.environ.get("SAMDESKTOP_LLAMASWAP_RESTART_CMD") or 'cmd /c "C:\\Tools\\nssm\\nssm.exe restart llama-swap"').strip()
    return (os.environ.get("GPU_LLAMASWAP_RESTART_CMD") or "sudo systemctl restart llama-swap").strip()


def _ensure_machine(machine_id: str) -> None:
    mid = normalize_machine_id(machine_id)
    if mid not in _configured_machine_ids():
        raise HTTPException(status_code=404, detail="Unknown machine_id")


class LlamaSwapConfigBody(BaseModel):
    yaml_text: str = Field(..., min_length=0)


class LlamaSwapWarmBody(BaseModel):
    model: str = Field(..., min_length=1)


def _loaded_model_from_running_payload(payload: Any) -> str | None:
    """Best-effort single model name from llama-swap GET /running JSON."""
    if payload is None:
        return None
    if isinstance(payload, str):
        s = payload.strip()
        return s if s else None
    if isinstance(payload, list):
        if not payload:
            return None
        first = payload[0]
        if isinstance(first, str):
            s = first.strip()
            return s if s else None
        if isinstance(first, dict):
            for k in ("id", "model", "model_id", "name"):
                v = first.get(k)
                if isinstance(v, str) and v.strip():
                    return v.strip()
        return None
    if isinstance(payload, dict):
        for k in ("model", "current_model", "model_id", "id", "name"):
            v = payload.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
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
        return sorted(models.keys())
    return []


@router.get("/{machine_id}/config", dependencies=[Depends(require_admin)])
async def get_llamaswap_config(machine_id: str):
    _ensure_machine(machine_id)
    path = _llamaswap_config_path(machine_id)
    conn = await connect_for_machine(machine_id)
    try:
        text = await ssh_read_file(conn, path)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        conn.close()
    return {"path": path, "yaml_text": text}


@router.put("/{machine_id}/config", dependencies=[Depends(require_admin)])
async def put_llamaswap_config(machine_id: str, body: LlamaSwapConfigBody):
    _ensure_machine(machine_id)
    path = _llamaswap_config_path(machine_id)
    try:
        yaml.safe_load(body.yaml_text or "")
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}") from e
    conn = await connect_for_machine(machine_id)
    try:
        await ssh_write_file(conn, path, body.yaml_text)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        conn.close()
    out, err, code = await machine_ssh_exec(machine_id, _restart_cmd(machine_id))
    if code != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Restart failed (exit {code}): {(err or out)[:2000]}",
        )
    return {"ok": True, "path": path}


@router.get("/{machine_id}/models", dependencies=[Depends(require_admin)])
async def list_llamaswap_models(machine_id: str):
    _ensure_machine(machine_id)
    path = _llamaswap_config_path(machine_id)
    conn = await connect_for_machine(machine_id)
    try:
        text = await ssh_read_file(conn, path)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        conn.close()
    return {"models": [{"id": mid} for mid in _model_ids_from_config(text)]}


@router.get("/{machine_id}/running", dependencies=[Depends(require_admin)])
async def llamaswap_running(machine_id: str):
    _ensure_machine(machine_id)
    base = _llamaswap_base_url(machine_id)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            r = await client.get(f"{base}/running")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if r.status_code == 404:
        # endpoint not available (e.g. tabbyAPI instead of llama-swap) — return empty
        return {"url": base, "running": None, "loaded_model": None}
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"/running HTTP {r.status_code}")
    try:
        payload: Any = r.json()
    except httpx.JSONDecodeError:
        payload = {"raw": (r.text or "")[:4000]}
    loaded = _loaded_model_from_running_payload(payload)
    return {"url": base, "running": payload, "loaded_model": loaded}


@router.post("/{machine_id}/warm", dependencies=[Depends(require_admin)])
async def llamaswap_warm(machine_id: str, body: LlamaSwapWarmBody):
    _ensure_machine(machine_id)
    base = _llamaswap_base_url(machine_id)
    url = f"{base}/v1/chat/completions"
    model = body.model.strip()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "stream": True,
    }
    timeout = httpx.Timeout(60.0, connect=15.0)

    async def _drain_stream() -> None:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, json=payload) as resp:
                if resp.status_code >= 400:
                    err_b = await resp.aread()
                    msg = err_b.decode("utf-8", errors="replace")[:2000] or resp.reason_phrase
                    raise HTTPException(status_code=502, detail=f"llama-swap chat HTTP {resp.status_code}: {msg}")
                async for _ in resp.aiter_bytes():
                    pass

    try:
        await asyncio.wait_for(_drain_stream(), timeout=60.0)
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Warm request timed out after 60s") from None
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    return {"ok": True}


@router.post("/{machine_id}/restart", dependencies=[Depends(require_admin)])
async def llamaswap_restart_service(machine_id: str):
    _ensure_machine(machine_id)
    out, err, code = await machine_ssh_exec(machine_id, _restart_cmd(machine_id))
    if code != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Restart failed (exit {code}): {(err or out)[:2000]}",
        )
    return {"ok": True}


@router.post("/{machine_id}/unload", dependencies=[Depends(require_admin)])
async def llamaswap_unload(machine_id: str):
    _ensure_machine(machine_id)
    base = _llamaswap_base_url(machine_id)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            r = await client.post(f"{base}/models/unload", json={})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if r.status_code >= 400:
        out, err, code = await machine_ssh_exec(machine_id, _restart_cmd(machine_id))
        if code != 0:
            raise HTTPException(
                status_code=502,
                detail=f"Unload HTTP {r.status_code}; restart failed: {(err or out)[:1500]}",
            )
        return {"ok": True, "method": "service_restart", "unload_status": r.status_code}
    return {"ok": True, "method": "http_unload", "unload_status": r.status_code}
