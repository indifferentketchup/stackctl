"""Bifrost OpenAI-router: proxy to Bifrost REST API."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from auth_deps import require_admin

router = APIRouter()


def _bifrost_url() -> str:
    u = (os.environ.get("BIFROST_URL") or "").strip().rstrip("/")
    if not u:
        raise HTTPException(status_code=503, detail="BIFROST_URL is not configured")
    return u


@router.get("/providers", dependencies=[Depends(require_admin)])
async def list_providers():
    base = _bifrost_url()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.get(f"{base}/api/providers")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Bifrost unreachable: {e}") from e
    try:
        payload = r.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Invalid JSON from Bifrost /api/providers")
    return {"providers": payload.get("providers", [])}


@router.get("/keys", dependencies=[Depends(require_admin)])
async def list_keys():
    base = _bifrost_url()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.get(f"{base}/api/keys")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Bifrost unreachable: {e}") from e
    try:
        payload = r.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Invalid JSON from Bifrost /api/keys")
    return payload


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
