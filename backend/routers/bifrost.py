"""Bifrost OpenAI-router: local config file + HTTP checks."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import httpx
import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_deps import require_admin

router = APIRouter()


def _bifrost_url() -> str:
    u = (os.environ.get("BIFROST_URL") or "").strip().rstrip("/")
    if not u:
        raise HTTPException(status_code=503, detail="BIFROST_URL is not configured")
    return u


def _config_path() -> str:
    p = (os.environ.get("BIFROST_CONFIG_PATH") or "").strip()
    if not p:
        raise HTTPException(status_code=503, detail="BIFROST_CONFIG_PATH is not configured")
    return p


def _compose_path() -> str:
    return (os.environ.get("BIFROST_COMPOSE_PATH") or "/opt/bifrost/docker-compose.yml").strip()


class BifrostConfigBody(BaseModel):
    yaml_text: str = Field(..., min_length=0)


@router.get("/config", dependencies=[Depends(require_admin)])
async def get_bifrost_config():
    path = _config_path()
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Cannot read config: {e}") from e
    return {"path": path, "yaml_text": text}


@router.put("/config", dependencies=[Depends(require_admin)])
async def put_bifrost_config(body: BifrostConfigBody):
    path = _config_path()
    try:
        yaml.safe_load(body.yaml_text or "")  # validate
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}") from e
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(body.yaml_text)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Cannot write config: {e}") from e

    compose = _compose_path()
    proc = await asyncio.create_subprocess_exec(
        "docker",
        "compose",
        "-f",
        compose,
        "restart",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await proc.communicate()
    if proc.returncode != 0:
        msg = (err_b or out_b or b"").decode("utf-8", errors="replace")[:4000]
        raise HTTPException(status_code=500, detail=f"docker compose restart failed: {msg}")
    return {"ok": True, "path": path, "compose": compose}


@router.get("/providers", dependencies=[Depends(require_admin)])
async def list_providers():
    path = _config_path()
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Cannot read config: {e}") from e
    except yaml.YAMLError as e:
        raise HTTPException(status_code=500, detail=f"Invalid YAML: {e}") from e
    if not isinstance(data, dict):
        return {"providers": []}
    prov = data.get("providers")
    if isinstance(prov, list):
        return {"providers": prov}
    if isinstance(prov, dict):
        return {"providers": [{"name": k, **(v if isinstance(v, dict) else {"value": v})} for k, v in prov.items()]}
    return {"providers": []}


@router.get("/models", dependencies=[Depends(require_admin)])
async def bifrost_models():
    base = _bifrost_url()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.get(f"{base}/v1/models")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Bifrost unreachable: {e}") from e
    try:
        payload = r.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Invalid JSON from Bifrost /v1/models")
    return payload


@router.get("/health")
async def bifrost_health():
    base = (os.environ.get("BIFROST_URL") or "").strip().rstrip("/")
    if not base:
        return {"ok": False, "status_code": None, "url": "", "error": "BIFROST_URL not set"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            r = await client.get(f"{base}/v1/models")
        ok = r.status_code < 500
        return {"ok": ok, "status_code": r.status_code, "url": base}
    except httpx.HTTPError as e:
        return {"ok": False, "status_code": None, "url": base, "error": str(e)}
