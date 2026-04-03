"""Ollama HTTP API reverse proxy — single entrypoint; routes by model assignment."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from machine_queries import get_route_for_model, list_machines

router = APIRouter()

PROXY_TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=5.0)

_REQ_EXCLUDE = frozenset(
    {
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "keep-alive",
        "proxy-connection",
        "upgrade",
    }
)

_RESP_EXCLUDE = frozenset(
    {
        "connection",
        "transfer-encoding",
        "keep-alive",
        "proxy-connection",
        "upgrade",
        "content-length",
        "content-encoding",
    }
)


def _forward_request_headers(request: Request) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in _REQ_EXCLUDE:
            continue
        out[k] = v
    return out


def _forward_response_headers(resp: httpx.Response) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in resp.headers.items():
        if k.lower() in _RESP_EXCLUDE:
            continue
        out[k] = v
    return out


def _routing_field_for_path(path_suffix: str) -> str:
    if path_suffix == "/api/show":
        return "name"
    return "model"


def _extract_route_model(path_suffix: str, data: Any) -> str | None:
    key = _routing_field_for_path(path_suffix)
    if not isinstance(data, dict):
        return None
    raw = data.get(key)
    if raw is None:
        return None
    if isinstance(raw, str):
        s = raw.strip()
        return s if s else None
    return str(raw).strip() or None


def _wants_stream(body_json: Any, request: Request) -> bool:
    ct = (request.headers.get("content-type") or "").lower()
    if "application/x-ndjson" in ct:
        return True
    if isinstance(body_json, dict) and body_json.get("stream") is True:
        return True
    return False


def _not_assigned_response(model: str) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": (
                f"Model '{model}' is not assigned to any machine. "
                "Visit ai.indifferentketchup.com/machines to assign it."
            )
        },
    )


async def _proxy_post(path_suffix: str, request: Request) -> Response:
    body = await request.body()
    try:
        data = json.loads(body.decode("utf-8") if body else "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return JSONResponse(status_code=422, content={"error": "Invalid JSON body"})

    route_model = _extract_route_model(path_suffix, data)
    if not route_model:
        key = _routing_field_for_path(path_suffix)
        return JSONResponse(
            status_code=422,
            content={"error": f"Missing '{key}' in request body"},
        )

    route = await get_route_for_model(route_model)
    if not route:
        return _not_assigned_response(route_model)

    base = str(route["ollama_url"]).rstrip("/")
    target = f"{base}{path_suffix}"
    fwd_h = _forward_request_headers(request)

    if _wants_stream(data, request):
        client = httpx.AsyncClient(timeout=PROXY_TIMEOUT)
        try:
            req = client.build_request("POST", target, content=body, headers=fwd_h)
            resp = await client.send(req, stream=True)
        except Exception:
            await client.aclose()
            raise

        if resp.status_code >= 400:
            err = await resp.aread()
            await resp.aclose()
            await client.aclose()
            return Response(
                content=err,
                status_code=resp.status_code,
                headers=_forward_response_headers(resp),
            )

        out_h = _forward_response_headers(resp)

        async def iterate() -> AsyncIterator[bytes]:
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        return StreamingResponse(
            iterate(),
            status_code=resp.status_code,
            headers=out_h,
        )

    try:
        async with httpx.AsyncClient(timeout=PROXY_TIMEOUT) as client:
            r = await client.post(target, content=body, headers=fwd_h)
    except httpx.HTTPError as e:
        return JSONResponse(status_code=502, content={"error": str(e)})

    return Response(
        content=r.content,
        status_code=r.status_code,
        headers=_forward_response_headers(r),
    )


async def _merge_models_json(path: str) -> Response:
    machines = await list_machines()
    if not machines:
        return Response(content=json.dumps({"models": []}).encode(), media_type="application/json")

    async def fetch_one(minfo: dict[str, Any]) -> list[dict[str, Any]]:
        base = str(minfo["ollama_url"]).rstrip("/")
        mname = str(minfo["name"])
        try:
            async with httpx.AsyncClient(timeout=PROXY_TIMEOUT) as client:
                r = await client.get(f"{base}{path}")
                if r.status_code != 200:
                    return []
                payload = r.json()
        except Exception:
            return []
        models = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(models, list):
            return []
        out: list[dict[str, Any]] = []
        for x in models:
            if isinstance(x, dict):
                out.append({**x, "machine_name": mname})
        return out

    results = await asyncio.gather(*[fetch_one(m) for m in machines], return_exceptions=True)
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for res in results:
        if isinstance(res, BaseException):
            continue
        for m in res:
            if not isinstance(m, dict):
                continue
            name = (m.get("name") or m.get("model") or "").strip()
            if not name:
                continue
            if name in seen:
                continue
            seen.add(name)
            merged.append(m)
    return Response(
        content=json.dumps({"models": merged}).encode(),
        media_type="application/json",
    )


@router.post("/api/chat")
async def proxy_chat(request: Request):
    return await _proxy_post("/api/chat", request)


@router.post("/api/generate")
async def proxy_generate(request: Request):
    return await _proxy_post("/api/generate", request)


@router.post("/api/embeddings")
async def proxy_embeddings(request: Request):
    return await _proxy_post("/api/embeddings", request)


@router.post("/api/embed")
async def proxy_embed(request: Request):
    return await _proxy_post("/api/embed", request)


@router.post("/api/show")
async def proxy_show(request: Request):
    return await _proxy_post("/api/show", request)


@router.get("/api/tags")
async def proxy_tags():
    return await _merge_models_json("/api/tags")


@router.get("/api/ps")
async def proxy_ps():
    return await _merge_models_json("/api/ps")
