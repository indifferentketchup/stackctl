"""Ollama proxy for ollamactl — models, pull/create SSE, running, modelfile ops."""

from __future__ import annotations

import json
import os
import re
import uuid
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from auth_deps import require_admin
from sam_ssh import (
    connect_sam_desktop,
    iter_ssh_cmd_lines,
    powershell_single_quote,
    remote_temp_modelfile_path,
    ssh_remove_file,
    ssh_write_file,
)

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


class CreateQuantizedBody(BaseModel):
    name: str
    modelfile: str
    quantize: str | None = None


class VerifyPathBody(BaseModel):
    path: str


_ALLOWED_QUANTIZE = frozenset({"q8_0", "q4_K_S", "q4_K_M"})


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


async def _stream_ollama_create(
    name: str, modelfile: str, quantize: str | None = None
) -> AsyncIterator[bytes]:
    base = _ollama_base()
    payload: dict = {"name": name, "modelfile": modelfile, "stream": True}
    if quantize:
        payload["quantize"] = quantize
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


def _verify_path_ps(path: str) -> str:
    p_esc = path.replace("'", "''")
    inner = (
        f"$p = '{p_esc}'; "
        f"$exists = Test-Path -LiteralPath $p; "
        f"$isFile = $false; $isDir = $false; $sz = $null; "
        f"if ($exists) "
        f"{{ $i = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue; "
        f"if ($i) {{ $isFile = -not $i.PSIsContainer; $isDir = $i.PSIsContainer; "
        f"if ($isFile) {{ $sz = [int64]$i.Length }} }} }}; "
        f"@{{ exists = $exists; is_file = $isFile; is_dir = $isDir; size_bytes = $sz }} "
        f"| ConvertTo-Json -Compress"
    )
    return "powershell -NoProfile -Command " + powershell_single_quote(inner)


@router.post("/verify-path", dependencies=[Depends(require_admin)])
async def verify_path(body: VerifyPathBody):
    p = (body.path or "").strip().strip('"')
    if not p:
        raise HTTPException(status_code=400, detail="path is required")
    if "\x00" in p:
        raise HTTPException(status_code=400, detail="invalid path")
    conn = None
    try:
        try:
            conn = await connect_sam_desktop()
        except OSError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        r = await conn.run(_verify_path_ps(p), check=False, encoding="utf-8")
        out = (r.stdout or "").strip()
        if not out:
            return {"exists": False, "is_file": False, "is_dir": False, "size_bytes": None}
        try:
            data = json.loads(out.splitlines()[-1])
        except json.JSONDecodeError:
            return {"exists": False, "is_file": False, "is_dir": False, "size_bytes": None}
        if not isinstance(data, dict):
            return {"exists": False, "is_file": False, "is_dir": False, "size_bytes": None}
        exists = bool(data.get("exists"))
        is_file = bool(data.get("is_file"))
        is_dir = bool(data.get("is_dir"))
        raw_sz = data.get("size_bytes")
        size_bytes: int | None
        if raw_sz is None or raw_sz == "":
            size_bytes = None
        else:
            try:
                size_bytes = int(raw_sz)
            except (TypeError, ValueError):
                size_bytes = None
        return {"exists": exists, "is_file": is_file, "is_dir": is_dir, "size_bytes": size_bytes}
    finally:
        if conn:
            conn.close()
            await conn.wait_closed()


async def _ssh_create_quantized_sse(body: CreateQuantizedBody) -> AsyncIterator[bytes]:
    name = (body.name or "").strip()
    mf = body.modelfile or ""
    if not name:
        yield _sse(json.dumps({"type": "error", "message": "name is required"}))
        return
    if not mf.strip():
        yield _sse(json.dumps({"type": "error", "message": "modelfile is required"}))
        return
    raw_q = (body.quantize or "").strip() or None
    if raw_q and raw_q not in _ALLOWED_QUANTIZE:
        yield _sse(
            json.dumps(
                {
                    "type": "error",
                    "message": f"quantize must be one of: {', '.join(sorted(_ALLOWED_QUANTIZE))}",
                }
            )
        )
        return

    fname = f"ollamactl_quant_{uuid.uuid4().hex}.txt"
    conn = None
    remote_path = ""
    try:
        try:
            conn = await connect_sam_desktop()
        except OSError as e:
            yield _sse(json.dumps({"type": "error", "message": str(e)}))
            return

        remote_path = await remote_temp_modelfile_path(conn, fname)
        await ssh_write_file(conn, remote_path, mf)

        if raw_q:
            create_inner = f"ollama create {name} --quantize {raw_q} -f {remote_path}"
        else:
            create_inner = f"ollama create {name} -f {remote_path}"
        create_ps = "powershell -NoProfile -Command " + powershell_single_quote(create_inner)
        exit_c: int | None = None
        async for text, code in iter_ssh_cmd_lines(conn, create_ps):
            if text == "__end__":
                exit_c = code
                break
            yield _sse(json.dumps({"type": "log", "line": text}))

        if exit_c is None or exit_c != 0:
            yield _sse(
                json.dumps(
                    {
                        "type": "error",
                        "message": f"ollama create exited with code {exit_c}",
                    }
                )
            )
            return
        yield _sse(json.dumps({"type": "done", "success": True}))
    finally:
        if conn:
            if remote_path:
                await ssh_remove_file(conn, remote_path)
            conn.close()
            await conn.wait_closed()


@router.post("/create-quantized")
async def create_quantized(body: CreateQuantizedBody, _owner: dict = Depends(require_admin)):
    return StreamingResponse(
        _ssh_create_quantized_sse(body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _hf_metadata(data: dict) -> dict:
    meta: dict = {"architecture": None, "parameter_size": None, "license": None}
    pt = data.get("pipeline_tag")
    if isinstance(pt, str) and pt.strip():
        meta["architecture"] = pt.strip()
    cfg = data.get("config")
    if isinstance(cfg, dict) and not meta["architecture"]:
        mt = cfg.get("model_type")
        if isinstance(mt, str) and mt.strip():
            meta["architecture"] = mt.strip()
    st = data.get("safetensors")
    if isinstance(st, dict):
        tot = st.get("total")
        if tot is not None:
            meta["parameter_size"] = tot
    gguf = data.get("gguf")
    if isinstance(gguf, dict) and meta["parameter_size"] is None:
        tp = gguf.get("total_parameters")
        if tp is not None:
            meta["parameter_size"] = tp
    card = data.get("cardData")
    if isinstance(card, dict):
        lic = card.get("license")
        if isinstance(lic, str) and lic.strip():
            meta["license"] = lic.strip()
        elif isinstance(lic, list) and lic:
            meta["license"] = str(lic[0])
    if meta["license"] is None:
        top = data.get("license")
        if isinstance(top, str) and top.strip():
            meta["license"] = top.strip()
    return meta


@router.get("/hf-files")
async def hf_model_files(repo: str = Query(..., min_length=1)):
    raw = (repo or "").strip().strip("/")
    if not raw or ".." in raw.split("/"):
        raise HTTPException(status_code=400, detail="invalid repo")
    url = f"https://huggingface.co/api/models/{raw}"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(45.0),
            headers={"Accept": "application/json"},
        ) as client:
            r = await client.get(url)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if r.status_code == 404:
        return JSONResponse({"error": "repo not found"}, status_code=404)
    if r.status_code >= 400:
        detail = r.text[:2000] if r.text else r.reason_phrase
        raise HTTPException(status_code=502, detail=f"HuggingFace error: {detail}")
    try:
        data = r.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Invalid JSON from HuggingFace") from None
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Unexpected HuggingFace response")

    siblings = data.get("siblings")
    files: list[dict] = []
    if isinstance(siblings, list):
        for s in siblings:
            if not isinstance(s, dict):
                continue
            fn = s.get("rfilename") or s.get("path") or ""
            if not isinstance(fn, str) or not fn.lower().endswith(".gguf"):
                continue
            sz = s.get("size")
            files.append({"name": fn, "size": sz if isinstance(sz, (int, float)) else None})

    return {"metadata": _hf_metadata(data), "files": files, "repo_id": raw}


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
