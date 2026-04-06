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

_http_client: httpx.AsyncClient | None = None


async def startup_http_client() -> None:
    global _http_client
    _http_client = httpx.AsyncClient(timeout=PROXY_TIMEOUT)


async def shutdown_http_client() -> None:
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


def _client() -> httpx.AsyncClient:
    if _http_client is None:
        raise RuntimeError("ollama_proxy HTTP client not initialized")
    return _http_client


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


def _wants_stream(path_suffix: str, body_json: Any, request: Request) -> bool:
    ct = (request.headers.get("content-type") or "").lower()
    if "application/x-ndjson" in ct:
        return True
    if not isinstance(body_json, dict):
        return False
    if path_suffix in ("/api/chat", "/api/generate"):
        return body_json.get("stream") is not False
    return body_json.get("stream") is True


def _not_assigned_response(model: str) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": (
                f"Model '{model}' is not assigned to any machine. "
                "Configure model→machine assignments in the stackctl database (model_assignments)."
            )
        },
    )


def _unreachable_response(machine_name: str) -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={"error": f"Machine unreachable: {machine_name}"},
    )


async def _proxy_post(path_suffix: str, request: Request) -> Response:
    body = await request.body()
    try:
        data = json.loads(body.decode("utf-8") if body else "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})

    route_model = _extract_route_model(path_suffix, data)
    if not route_model:
        key = _routing_field_for_path(path_suffix)
        return JSONResponse(
            status_code=422,
            content={"error": f"Missing '{key}' in request body"},
        )

    row = await get_route_for_model(route_model)
    if not row:
        return _not_assigned_response(route_model)

    machine_name = str(row["name"])
    base = str(row["ollama_url"]).rstrip("/")
    target = f"{base}{path_suffix}"
    fwd_h = _forward_request_headers(request)
    client = _client()

    if _wants_stream(path_suffix, data, request):
        try:
            req = client.build_request("POST", target, content=body, headers=fwd_h)
            resp = await client.send(req, stream=True)
        except httpx.HTTPError:
            return _unreachable_response(machine_name)

        if resp.status_code >= 400:
            err = await resp.aread()
            await resp.aclose()
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

        return StreamingResponse(
            iterate(),
            status_code=resp.status_code,
            headers=out_h,
        )

    try:
        r = await client.post(target, content=body, headers=fwd_h)
    except httpx.HTTPError:
        return _unreachable_response(machine_name)

    return Response(
        content=r.content,
        status_code=r.status_code,
        headers=_forward_response_headers(r),
    )


async def _machine_get_json(
    ollama_url: str, path_suffix: str
) -> tuple[httpx.Response | None, httpx.HTTPError | None]:
    base = str(ollama_url).rstrip("/")
    url = f"{base}{path_suffix}"
    try:
        r = await _client().get(url)
        return r, None
    except httpx.HTTPError as e:
        return None, e


async def _tags_response() -> Response:
    machines = await list_machines()
    if not machines:
        return Response(content=json.dumps({"models": []}).encode(), media_type="application/json")

    async def fetch(minfo: dict[str, Any]) -> list[dict[str, Any]]:
        mlabel = str(minfo["name"])
        r, _err = await _machine_get_json(str(minfo["ollama_url"]), "/api/tags")
        if r is None or r.status_code != 200:
            return []
        try:
            payload = r.json()
        except json.JSONDecodeError:
            return []
        models = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(models, list):
            return []
        out: list[dict[str, Any]] = []
        for x in models:
            if isinstance(x, dict):
                out.append({**x, "machine": mlabel})
        return out

    results = await asyncio.gather(*[fetch(m) for m in machines], return_exceptions=True)
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for res in results:
        if isinstance(res, BaseException):
            continue
        for m in res:
            name = (m.get("name") or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            merged.append(m)
    return Response(
        content=json.dumps({"models": merged}).encode(),
        media_type="application/json",
    )


async def _v1_models_response() -> Response:
    machines = await list_machines()
    if not machines:
        return Response(
            content=json.dumps({"object": "list", "data": []}).encode(),
            media_type="application/json",
        )

    async def fetch(minfo: dict[str, Any]) -> list[dict[str, Any]]:
        mlabel = str(minfo["name"])
        r, _err = await _machine_get_json(str(minfo["ollama_url"]), "/v1/models")
        if r is None or r.status_code != 200:
            return []
        try:
            payload = r.json()
        except json.JSONDecodeError:
            return []
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            return []
        out: list[dict[str, Any]] = []
        for x in data:
            if isinstance(x, dict):
                out.append({**x, "machine": mlabel})
        return out

    results = await asyncio.gather(*[fetch(m) for m in machines], return_exceptions=True)
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for res in results:
        if isinstance(res, BaseException):
            continue
        for item in res:
            mid = (item.get("id") or "").strip()
            if not mid or mid in seen:
                continue
            seen.add(mid)
            merged.append(item)
    return Response(
        content=json.dumps({"object": "list", "data": merged}).encode(),
        media_type="application/json",
    )


async def _ps_response() -> Response:
    machines = await list_machines()
    if not machines:
        return Response(content=json.dumps({"models": []}).encode(), media_type="application/json")

    async def fetch(minfo: dict[str, Any]) -> list[dict[str, Any]]:
        mlabel = str(minfo["name"])
        r, _err = await _machine_get_json(str(minfo["ollama_url"]), "/api/ps")
        if r is None or r.status_code != 200:
            return []
        try:
            payload = r.json()
        except json.JSONDecodeError:
            return []
        models = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(models, list):
            return []
        out: list[dict[str, Any]] = []
        for x in models:
            if isinstance(x, dict):
                out.append({**x, "machine": mlabel})
        return out

    results = await asyncio.gather(*[fetch(m) for m in machines], return_exceptions=True)
    merged: list[dict[str, Any]] = []
    for res in results:
        if isinstance(res, BaseException):
            continue
        merged.extend(res)
    return Response(
        content=json.dumps({"models": merged}).encode(),
        media_type="application/json",
    )


async def _version_response() -> Response:
    machines = await list_machines()
    for minfo in machines:
        r, _err = await _machine_get_json(str(minfo["ollama_url"]), "/api/version")
        if r is not None and r.status_code == 200:
            return Response(
                content=r.content,
                status_code=r.status_code,
                headers=_forward_response_headers(r),
            )
    return JSONResponse(status_code=502, content={"error": "No Ollama instance reachable"})


@router.post("/v1/chat/completions")
async def proxy_v1_chat_completions(request: Request):
    return await _proxy_post("/v1/chat/completions", request)


@router.post("/v1/completions")
async def proxy_v1_completions(request: Request):
    return await _proxy_post("/v1/completions", request)


@router.post("/v1/embeddings")
async def proxy_v1_embeddings(request: Request):
    return await _proxy_post("/v1/embeddings", request)


@router.get("/v1/models")
async def proxy_v1_models():
    return await _v1_models_response()


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
    return await _tags_response()


@router.get("/api/ps")
async def proxy_ps():
    return await _ps_response()


@router.get("/api/version")
async def proxy_version():
    return await _version_response()
