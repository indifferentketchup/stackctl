"""Bifrost OpenAI-router: proxy to Bifrost REST API."""

from __future__ import annotations

import asyncio
import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse

from auth_deps import require_admin

router = APIRouter()


def _bifrost_url() -> str:
    u = (os.environ.get("BIFROST_URL") or "").strip().rstrip("/")
    if not u:
        raise HTTPException(status_code=503, detail="BIFROST_URL is not configured")
    return u


# --- Prometheus text format (manual parse) ---


def _parse_prometheus_labels(label_str: str) -> dict[str, str]:
    out: dict[str, str] = {}
    s = label_str.strip()
    if not s:
        return out
    i = 0
    n = len(s)
    while i < n:
        while i < n and s[i] in " \t":
            i += 1
        if i >= n:
            break
        eq = s.find("=", i)
        if eq < 0:
            break
        key = s[i:eq].strip()
        i = eq + 1
        while i < n and s[i] in " \t":
            i += 1
        if i >= n:
            break
        if s[i] == '"':
            i += 1
            val_parts: list[str] = []
            while i < n:
                c = s[i]
                if c == "\\" and i + 1 < n:
                    val_parts.append(s[i + 1])
                    i += 2
                    continue
                if c == '"':
                    i += 1
                    break
                val_parts.append(c)
                i += 1
            out[key] = "".join(val_parts)
        else:
            j = i
            while j < n and s[j] not in ",}":
                j += 1
            out[key] = s[i:j].strip()
            i = j
        while i < n and s[i] in " \t":
            i += 1
        if i < n and s[i] == ",":
            i += 1
    return out


def _parse_prometheus_line(line: str) -> tuple[str, dict[str, str], float] | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    ob = line.find("{")
    if ob >= 0:
        name = line[:ob].strip()
        cb = line.find("}", ob)
        if cb < 0:
            return None
        labels = _parse_prometheus_labels(line[ob + 1 : cb])
        rest = line[cb + 1 :].strip()
    else:
        parts = line.split()
        if len(parts) < 2:
            return None
        name = parts[0]
        labels = {}
        rest = parts[1]
    vlow = rest.split()[0].lower()
    if vlow in ("nan", "+inf", "-inf", "inf"):
        return None
    try:
        val = float(rest.split()[0])
    except ValueError:
        return None
    return (name, labels, val)


def _norm_quantile(q: str | None) -> float | None:
    if q is None:
        return None
    try:
        return float(q)
    except ValueError:
        return None


def _aggregate_prometheus_samples(
    lines: list[str],
) -> dict[str, Any]:
    req_pm: dict[tuple[str, str], float] = defaultdict(float)
    err_pm: dict[tuple[str, str], float] = defaultdict(float)
    tok_pmt: dict[tuple[str, str, str], float] = defaultdict(float)
    dur_pm_q: dict[tuple[str, str, float], float] = {}

    for ln in lines:
        parsed = _parse_prometheus_line(ln)
        if not parsed:
            continue
        name, labels, val = parsed
        provider = labels.get("provider") or ""
        model = labels.get("model") or ""

        if name == "bifrost_requests_total":
            req_pm[(provider, model)] += val
        elif name == "bifrost_errors_total":
            err_pm[(provider, model)] += val
        elif name == "bifrost_tokens_total":
            t = (labels.get("type") or "").lower()
            if t in ("prompt", "completion"):
                tok_pmt[(provider, model, t)] += val
        elif name == "bifrost_request_duration_seconds":
            qn = _norm_quantile(labels.get("quantile"))
            if qn is not None:
                dur_pm_q[(provider, model, qn)] = val

    providers_set: set[str] = set()
    for (p, _) in req_pm:
        providers_set.add(p)
    for (p, _) in err_pm:
        providers_set.add(p)
    for (p, _, _) in tok_pmt:
        providers_set.add(p)
    for (p, _, _) in dur_pm_q:
        providers_set.add(p)
    providers_set.discard("")

    def dur_ms(p: str, m: str, q_target: float) -> float | None:
        best: float | None = None
        for (pp, mm, q), v in dur_pm_q.items():
            if pp != p or mm != m:
                continue
            if abs(q - q_target) < 1e-6:
                best = v * 1000.0
        return best

    def weighted_latency(
        p: str, models: set[str], q_target: float, weights: dict[tuple[str, str], float]
    ) -> float | None:
        num = 0.0
        den = 0.0
        for m in models:
            w = weights.get((p, m), 0.0)
            if w <= 0:
                continue
            d = dur_ms(p, m, q_target)
            if d is None:
                continue
            num += w * d
            den += w
        if den <= 0:
            return None
        return num / den

    by_provider: dict[str, Any] = {}
    total_requests = 0.0
    total_errors = 0.0

    for p in sorted(providers_set):
        models_p = {m for (pp, m) in req_pm if pp == p} | {m for (pp, m) in err_pm if pp == p}
        models_p |= {m for (pp, mm, _) in tok_pmt if pp == p}
        models_p |= {m for (pp, mm, _) in dur_pm_q if pp == p}
        models_p.discard("")

        r_tot = sum(req_pm.get((p, m), 0.0) for m in models_p)
        e_tot = sum(err_pm.get((p, m), 0.0) for m in models_p)
        tp = sum(tok_pmt.get((p, m, "prompt"), 0.0) for m in models_p)
        tc = sum(tok_pmt.get((p, m, "completion"), 0.0) for m in models_p)

        total_requests += r_tot
        total_errors += e_tot

        wmap = {(p, m): req_pm.get((p, m), 0.0) for m in models_p}
        p50_p = weighted_latency(p, models_p, 0.5, wmap)
        p95_p = weighted_latency(p, models_p, 0.95, wmap)

        by_model: dict[str, Any] = {}
        for m in sorted(models_p):
            rr = int(req_pm.get((p, m), 0.0))
            ee = int(err_pm.get((p, m), 0.0))
            p50_m = dur_ms(p, m, 0.5)
            p95_m = dur_ms(p, m, 0.95)
            md: dict[str, Any] = {
                "requests_total": rr,
                "errors_total": ee,
            }
            if p50_m is not None:
                md["p50_ms"] = round(p50_m, 1)
            if p95_m is not None:
                md["p95_ms"] = round(p95_m, 1)
            by_model[m] = md

        entry: dict[str, Any] = {
            "requests_total": int(r_tot),
            "errors_total": int(e_tot),
            "tokens_prompt": int(tp),
            "tokens_completion": int(tc),
            "by_model": by_model,
        }
        if p50_p is not None:
            entry["p50_ms"] = round(p50_p, 1)
        if p95_p is not None:
            entry["p95_ms"] = round(p95_p, 1)
        by_provider[p] = entry

    return {
        "by_provider": by_provider,
        "total_requests": int(total_requests) if total_requests or by_provider else 0,
        "total_errors": int(total_errors) if total_errors or by_provider else 0,
    }


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


@router.get("/metrics", dependencies=[Depends(require_admin)])
async def bifrost_metrics():
    base = _bifrost_url()
    unavailable = {
        "by_provider": {},
        "total_requests": None,
        "total_errors": None,
        "scraped_at": None,
        "metrics_unavailable": True,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.get(f"{base}/metrics")
    except httpx.HTTPError:
        return unavailable
    if r.status_code == 404:
        return unavailable
    text = (r.text or "").strip()
    if not text:
        return unavailable
    scraped_at = (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    lines = text.splitlines()
    agg = _aggregate_prometheus_samples(lines)
    agg["scraped_at"] = scraped_at
    agg["metrics_unavailable"] = False
    return agg


def _provider_row_url(p: dict[str, Any]) -> str:
    return (p.get("url") or p.get("base_url") or "").strip().rstrip("/")


async def _probe_provider_health(client: httpx.AsyncClient, p: dict[str, Any]) -> dict[str, Any]:
    import time

    name = p.get("name") or p.get("key") or "unknown"
    url = _provider_row_url(p)
    if not url:
        return {"name": name, "url": "", "ok": False, "status_code": None, "latency_ms": None}

    t0 = time.perf_counter()

    async def _get(path: str) -> tuple[bool, int | None]:
        try:
            r = await client.get(f"{url}{path}", timeout=httpx.Timeout(5.0))
            return (True, r.status_code)
        except httpx.HTTPError:
            return (False, None)

    try:
        got, code = await _get("/health")
        if got and code is not None and 200 <= code < 300:
            ms = (time.perf_counter() - t0) * 1000.0
            return {
                "name": name,
                "url": url,
                "ok": True,
                "status_code": code,
                "latency_ms": round(ms, 1),
            }

        got2, code2 = await _get("/v1/models")
        if got2 and code2 is not None and 200 <= code2 < 300:
            ms = (time.perf_counter() - t0) * 1000.0
            return {
                "name": name,
                "url": url,
                "ok": True,
                "status_code": code2,
                "latency_ms": round(ms, 1),
            }

        return {
            "name": name,
            "url": url,
            "ok": False,
            "status_code": code2 if got2 else code,
            "latency_ms": None,
        }
    except Exception:
        return {
            "name": name,
            "url": url,
            "ok": False,
            "status_code": None,
            "latency_ms": None,
        }


@router.get("/provider-health", dependencies=[Depends(require_admin)])
async def bifrost_provider_health():
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
    providers = payload.get("providers", [])
    if not isinstance(providers, list):
        providers = []

    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as hc:
        rows = await asyncio.gather(*[_probe_provider_health(hc, p) for p in providers])

    return {"providers": list(rows)}


@router.post("/providers", dependencies=[Depends(require_admin)])
async def create_provider(body: dict[str, Any] = Body(...)):
    base = _bifrost_url()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.post(f"{base}/api/providers", json=body)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Bifrost unreachable: {e}") from e
    try:
        content = r.json()
    except json.JSONDecodeError:
        content = {"raw": r.text}
    return JSONResponse(content=content, status_code=r.status_code)


@router.delete("/providers/{provider_name}", dependencies=[Depends(require_admin)])
async def delete_provider(provider_name: str):
    base = _bifrost_url()
    from urllib.parse import quote

    safe = quote(provider_name, safe="")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.delete(f"{base}/api/providers/{safe}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Bifrost unreachable: {e}") from e
    if r.status_code >= 400:
        try:
            detail = r.json()
        except json.JSONDecodeError:
            detail = r.text
        raise HTTPException(status_code=r.status_code, detail=detail)
    return {"ok": True}


@router.post("/providers/{provider_name}/keys", dependencies=[Depends(require_admin)])
async def add_provider_key(provider_name: str, body: dict[str, Any] = Body(...)):
    base = _bifrost_url()
    from urllib.parse import quote

    safe = quote(provider_name, safe="")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.post(f"{base}/api/providers/{safe}/keys", json=body)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Bifrost unreachable: {e}") from e
    try:
        content = r.json()
    except json.JSONDecodeError:
        content = {"raw": r.text}
    return JSONResponse(content=content, status_code=r.status_code)


@router.delete("/providers/{provider_name}/keys/{key_id}", dependencies=[Depends(require_admin)])
async def delete_provider_key(provider_name: str, key_id: str):
    base = _bifrost_url()
    from urllib.parse import quote

    ps = quote(provider_name, safe="")
    ks = quote(key_id, safe="")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.delete(f"{base}/api/providers/{ps}/keys/{ks}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Bifrost unreachable: {e}") from e
    if r.status_code >= 400:
        try:
            detail = r.json()
        except json.JSONDecodeError:
            detail = r.text
        raise HTTPException(status_code=r.status_code, detail=detail)
    return {"ok": True}
