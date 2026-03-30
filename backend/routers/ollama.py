"""Ollama proxy for ollamactl — models, pull/create SSE, running, modelfile ops."""

from __future__ import annotations

import json
import os
import re
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth_deps import require_admin

router = APIRouter()


def _ollama_base() -> str:
    return os.environ.get("OLLAMA_URL", "http://100.101.41.16:11434").rstrip("/")


def _sse(data: str) -> bytes:
    return f"data: {data}\n\n".encode("utf-8")


class PullBody(BaseModel):
    model: str


class CreateBody(BaseModel):
    name: str
    modelfile: str


class CopyBody(BaseModel):
    source: str
    destination: str


@router.get("/models")
async def list_models():
    base = _ollama_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.get(f"{base}/api/tags")
            r.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {e}") from e
    return r.json()


@router.get("/running", dependencies=[Depends(require_admin)])
async def running_models():
    base = _ollama_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.get(f"{base}/api/ps")
            r.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {e}") from e
    return r.json()


@router.post("/unload/{model_name:path}", dependencies=[Depends(require_admin)])
async def unload_model(model_name: str):
    if not model_name.strip():
        raise HTTPException(status_code=400, detail="model name is required")
    base = _ollama_base()
    name = model_name.strip()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            r = await client.post(
                f"{base}/api/generate",
                json={"model": name, "prompt": "", "keep_alive": 0, "stream": False},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {e}") from e
    if r.status_code >= 400:
        detail = r.text[:2000] if r.text else r.reason_phrase
        raise HTTPException(status_code=502, detail=f"Ollama error: {detail}")
    return {"ok": True}


@router.get("/show", dependencies=[Depends(require_admin)])
async def show_model(name: str = Query(..., min_length=1)):
    base = _ollama_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            r = await client.post(f"{base}/api/show", json={"name": name.strip()})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {e}") from e
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Model not found")
    if r.status_code >= 400:
        detail = r.text[:2000] if r.text else r.reason_phrase
        raise HTTPException(status_code=502, detail=f"Ollama error: {detail}")
    try:
        return r.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Invalid JSON from Ollama") from None


@router.get("/version", dependencies=[Depends(require_admin)])
async def ollama_version():
    base = _ollama_base()
    running_ver = ""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.get(f"{base}/api/version")
            r.raise_for_status()
            data = r.json()
            running_ver = str(data.get("version") or "").strip()
    except Exception:
        running_ver = ""

    latest_ver = ""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            gr = await client.get(
                "https://api.github.com/repos/ollama/ollama/releases/latest",
                headers={"Accept": "application/vnd.github+json"},
            )
            if gr.status_code == 200:
                body = gr.json()
                tag = str(body.get("tag_name") or "")
                latest_ver = re.sub(r"^v", "", tag, flags=re.I).strip()
    except Exception:
        pass

    update_available = False
    if running_ver and latest_ver:
        try:
            update_available = _version_tuple(latest_ver) > _version_tuple(running_ver)
        except Exception:
            update_available = latest_ver != running_ver

    return {
        "running": running_ver or None,
        "latest": latest_ver or None,
        "update_available": update_available,
    }


def _version_tuple(v: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", v)
    return tuple(int(p) for p in parts) if parts else (0,)


async def _stream_ollama_pull(model: str) -> AsyncIterator[bytes]:
    base = _ollama_base()
    payload = {"model": model, "stream": True}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(None)) as client:
            async with client.stream("POST", f"{base}/api/pull", json=payload) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    err = text.decode("utf-8", errors="replace")[:2000]
                    yield _sse(json.dumps({"error": f"Ollama error {resp.status_code}: {err}"}))
                    return
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    yield _sse(json.dumps(chunk))
                    if chunk.get("status") == "success":
                        yield _sse("[DONE]")
                        return
    except httpx.HTTPError as e:
        yield _sse(json.dumps({"error": str(e)}))


async def _stream_ollama_create(name: str, modelfile: str) -> AsyncIterator[bytes]:
    base = _ollama_base()
    payload = {"name": name, "modelfile": modelfile, "stream": True}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(None)) as client:
            async with client.stream("POST", f"{base}/api/create", json=payload) as resp:
                if resp.status_code >= 400:
                    text = await resp.aread()
                    err = text.decode("utf-8", errors="replace")[:2000]
                    yield _sse(json.dumps({"error": f"Ollama error {resp.status_code}: {err}"}))
                    return
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    yield _sse(json.dumps(chunk))
                    if chunk.get("status") == "success":
                        yield _sse("[DONE]")
                        return
    except httpx.HTTPError as e:
        yield _sse(json.dumps({"error": str(e)}))


@router.post("/pull")
async def pull_model(body: PullBody, _owner: dict = Depends(require_admin)):
    if not body.model or not body.model.strip():
        raise HTTPException(status_code=400, detail="model is required")
    return StreamingResponse(
        _stream_ollama_pull(body.model.strip()),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/create")
async def create_model(body: CreateBody, _owner: dict = Depends(require_admin)):
    name = (body.name or "").strip()
    mf = body.modelfile or ""
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if not mf.strip():
        raise HTTPException(status_code=400, detail="modelfile is required")
    return StreamingResponse(
        _stream_ollama_create(name, mf),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/copy", dependencies=[Depends(require_admin)])
async def copy_model(body: CopyBody):
    src = (body.source or "").strip()
    dst = (body.destination or "").strip()
    if not src or not dst:
        raise HTTPException(status_code=400, detail="source and destination are required")
    base = _ollama_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            r = await client.post(
                f"{base}/api/copy",
                json={"source": src, "destination": dst},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {e}") from e
    if r.status_code >= 400:
        detail = r.text[:2000] if r.text else r.reason_phrase
        raise HTTPException(status_code=502, detail=f"Ollama error: {detail}")
    return {"ok": True}


@router.delete("/models/{model_name:path}")
async def delete_ollama_model(model_name: str, _owner: dict = Depends(require_admin)):
    if not model_name.strip():
        raise HTTPException(status_code=400, detail="model name is required")
    base = _ollama_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            r = await client.request(
                "DELETE",
                f"{base}/api/delete",
                json={"name": model_name},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {e}") from e
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Model not found")
    if r.status_code >= 400:
        detail = r.text[:2000] if r.text else r.reason_phrase
        raise HTTPException(status_code=502, detail=f"Ollama error: {detail}")
    return {"ok": True}


@router.post("/unload-all")
async def unload_all_models(_owner: dict = Depends(require_admin)):
    base = _ollama_base()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.get(f"{base}/api/ps")
            r.raise_for_status()
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Ollama unreachable") from None
    try:
        data = r.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Ollama unreachable") from None

    models = data.get("models")
    if not isinstance(models, list) or len(models) == 0:
        return {"unloaded": []}

    names: list[str] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        raw = item.get("name") or item.get("model")
        if isinstance(raw, str) and raw.strip():
            names.append(raw.strip())

    if not names:
        return {"unloaded": []}

    unloaded: list[str] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for name in names:
            try:
                await client.post(
                    f"{base}/api/generate",
                    json={"model": name, "prompt": "", "keep_alive": 0, "stream": False},
                )
            except httpx.HTTPError:
                pass
            unloaded.append(name)

    return {"unloaded": unloaded}
