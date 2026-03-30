"""Proxy persona CRUD and icon uploads to boolab's REST API."""

from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from auth_deps import require_admin

router = APIRouter(dependencies=[Depends(require_admin)])


def _boolab_base() -> str:
    return os.environ.get("BOOLAB_API_URL", "http://100.114.205.53:9300").rstrip("/")


def _boolab_token() -> str:
    t = (os.environ.get("BOOLAB_OWNER_TOKEN") or "").strip()
    if not t:
        raise HTTPException(
            status_code=503,
            detail="BOOLAB_OWNER_TOKEN is not configured on the server",
        )
    return t


def _boolab_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_boolab_token()}"}


def _raise_boolab_error(r: httpx.Response) -> None:
    detail = (r.text or r.reason_phrase or "boolab error")[:2000]
    raise HTTPException(status_code=r.status_code, detail=detail)


class PersonaCreateBody(BaseModel):
    name: str = Field(..., min_length=1)
    system_prompt: str = ""
    avatar_emoji: str = "🤖"


class PersonaUpdateBody(BaseModel):
    name: str | None = None
    system_prompt: str | None = None
    avatar_emoji: str | None = None
    is_default_booops: bool | None = None
    is_default_808notes: bool | None = None
    icon_url: str | None = None


@router.get("")
async def list_personas():
    base = _boolab_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.get(f"{base}/api/personas/", headers=_boolab_headers())
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Boolab API unreachable: {e}") from e
    if r.status_code >= 400:
        _raise_boolab_error(r)
    return r.json()


@router.post("")
async def create_persona(body: PersonaCreateBody):
    base = _boolab_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.post(
                f"{base}/api/personas/",
                headers={**_boolab_headers(), "Content-Type": "application/json"},
                json=body.model_dump(),
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Boolab API unreachable: {e}") from e
    if r.status_code >= 400:
        _raise_boolab_error(r)
    return r.json()


@router.put("/{persona_id}")
async def update_persona(persona_id: str, body: PersonaUpdateBody):
    base = _boolab_base()
    payload = body.model_dump(exclude_unset=True)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.put(
                f"{base}/api/personas/{persona_id}",
                headers={**_boolab_headers(), "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Boolab API unreachable: {e}") from e
    if r.status_code >= 400:
        _raise_boolab_error(r)
    return r.json()


@router.delete("/{persona_id}")
async def delete_persona(persona_id: str):
    base = _boolab_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.delete(
                f"{base}/api/personas/{persona_id}",
                headers=_boolab_headers(),
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Boolab API unreachable: {e}") from e
    if r.status_code >= 400:
        _raise_boolab_error(r)
    return r.json()


@router.post("/{persona_id}/icon")
async def upload_persona_icon(persona_id: str, file: UploadFile = File(...)):
    base = _boolab_base()
    content = await file.read()
    filename = (file.filename or "icon.png").strip() or "icon.png"
    content_type = file.content_type or "application/octet-stream"
    files = {"file": (filename, content, content_type)}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            r = await client.post(
                f"{base}/api/personas/{persona_id}/icon",
                headers=_boolab_headers(),
                files=files,
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Boolab API unreachable: {e}") from e
    if r.status_code >= 400:
        _raise_boolab_error(r)
    return r.json()


@router.post("/{persona_id}/set-default")
async def set_default_persona(
    persona_id: str,
    slot: str = Query(..., description="booops or 808notes"),
):
    if slot not in ("booops", "808notes"):
        raise HTTPException(status_code=400, detail='slot must be "booops" or "808notes"')
    base = _boolab_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.post(
                f"{base}/api/personas/{persona_id}/set-default",
                headers=_boolab_headers(),
                params={"slot": slot},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Boolab API unreachable: {e}") from e
    if r.status_code >= 400:
        _raise_boolab_error(r)
    return r.json()


@router.get("/{persona_id}/icon-asset")
async def proxy_persona_icon_asset(persona_id: str):
    """Stream icon bytes from boolab so the UI can load images with the same admin Bearer token."""
    base = _boolab_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            r = await client.get(
                f"{base}/api/personas/{persona_id}/icon-asset",
                headers=_boolab_headers(),
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Boolab API unreachable: {e}") from e
    if r.status_code >= 400:
        _raise_boolab_error(r)
    ct = r.headers.get("content-type", "application/octet-stream")
    return Response(content=r.content, media_type=ct)
