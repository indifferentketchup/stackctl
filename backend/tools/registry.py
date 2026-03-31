"""Execute registered tools (HTTP + SSH where required)."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlparse

import httpx

from sam_ssh import connect_sam_desktop, iter_ssh_cmd_lines, powershell_single_quote


def _truncate(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return s[: n - 3] + "..."


def _domain_allowed(url: str, allowed: list[str]) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    for d in allowed:
        dh = d.strip().lower().lstrip(".")
        if not dh:
            continue
        if host == dh or host.endswith("." + dh):
            return True
    return False


async def _ssh_powershell_line(ps_inner: str) -> tuple[str, int]:
    cmd = "powershell -NoProfile -Command " + powershell_single_quote(ps_inner)
    conn = None
    out_lines: list[str] = []
    code = -1
    try:
        conn = await connect_sam_desktop()
        async for text, ec in iter_ssh_cmd_lines(conn, cmd):
            if text == "__end__":
                code = ec if ec is not None else -1
                break
            if text:
                out_lines.append(text)
        return ("\n".join(out_lines), int(code))
    finally:
        if conn:
            conn.close()
            await conn.wait_closed()


async def web_search(config: dict[str, Any], args: dict[str, Any]) -> str:
    q = str(args.get("query") or args.get("q") or "").strip()
    if not q:
        return "[]"
    base = (config.get("searxng_url") or os.environ.get("SEARXNG_URL") or "").rstrip("/")
    if not base:
        return json.dumps([{"title": "", "url": "", "snippet": "SEARXNG_URL not configured"}])
    max_results = int(config.get("max_results") or 5)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.get(
                f"{base}/search",
                params={"q": q, "format": "json"},
            )
            if r.status_code >= 400:
                return json.dumps([{"error": r.text[:500]}])
            data = r.json()
    except Exception as e:
        return json.dumps([{"error": str(e)}])
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        return "[]"
    slim: list[dict[str, str]] = []
    for item in results[:max_results]:
        if not isinstance(item, dict):
            continue
        slim.append(
            {
                "title": str(item.get("title") or "")[:200],
                "url": str(item.get("url") or "")[:500],
                "snippet": str(item.get("content") or item.get("description") or "")[:500],
            }
        )
    return json.dumps(slim, ensure_ascii=False)


async def http_request(config: dict[str, Any], args: dict[str, Any]) -> str:
    url = str(args.get("url") or "").strip()
    if not url:
        return "missing url"
    allowed = config.get("allowed_domains") or []
    if isinstance(allowed, str):
        allowed = [x.strip() for x in allowed.split(",") if x.strip()]
    if isinstance(allowed, list) and allowed and not _domain_allowed(url, [str(x) for x in allowed]):
        return "domain not allowed"
    timeout = float(config.get("timeout") or 20)
    method = str(args.get("method") or "GET").upper()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            r = await client.request(method, url)
            body = r.text
    except Exception as e:
        return _truncate(str(e), 2000)
    return _truncate(body, 2000)


async def boolab_rag(config: dict[str, Any], args: dict[str, Any]) -> str:
    daw_id = str(config.get("daw_id") or "").strip()
    query = str(args.get("query") or args.get("q") or "").strip()
    base = (os.environ.get("BOOLAB_API_URL") or "").rstrip("/")
    if not base or not daw_id:
        return "BOOLAB_API_URL or daw_id missing"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            r = await client.post(
                f"{base}/api/daws/{daw_id}/rag/query",
                json={"query": query, "top_k": int(args.get("top_k") or 5)},
            )
            if r.status_code >= 400:
                return _truncate(r.text, 4000)
            return _truncate(r.text, 4000)
    except Exception as e:
        return _truncate(str(e), 4000)


async def caldav_read(config: dict[str, Any], args: dict[str, Any]) -> str:
    _ = args
    url = str(config.get("caldav_url") or "").strip()
    if not url:
        return "caldav_url not set in tool config"
    return json.dumps(
        {
            "note": "CalDAV stub — configure Baikal URL and credentials in tool config",
            "url": url,
            "calendar": config.get("calendar_name"),
        }
    )


async def file_read(config: dict[str, Any], args: dict[str, Any]) -> str:
    raw_path = str(args.get("path") or "").strip().strip('"')
    if not raw_path:
        return "path required"
    allowed = config.get("allowed_paths") or []
    if isinstance(allowed, str):
        allowed = [allowed]
    norm = raw_path.replace("/", "\\").lower()
    ok = False
    for prefix in allowed:
        p = str(prefix).strip().rstrip("\\").lower()
        if p and norm.startswith(p.lower()):
            ok = True
            break
    if not ok:
        return "path not under allowed_paths"
    inner = f"Get-Content -LiteralPath {powershell_single_quote(raw_path)} -Raw -ErrorAction Stop"
    stdout, code = await _ssh_powershell_line(inner)
    if code != 0:
        return _truncate(stdout or "read failed", 4000)
    return _truncate(stdout, 4000)


async def run_powershell(config: dict[str, Any], args: dict[str, Any]) -> str:
    cmd = str(args.get("command") or "").strip()
    if not cmd:
        return "command required"
    allowed = config.get("allowed_commands") or config.get("allowed_command_prefixes") or []
    if isinstance(allowed, str):
        allowed = [allowed]
    allowed = [str(x).strip() for x in allowed if str(x).strip()]
    if not allowed or not any(cmd.startswith(p) for p in allowed):
        return "command not allowed by whitelist"
    inner = cmd
    stdout, code = await _ssh_powershell_line(inner)
    return _truncate(f"exit={code}\n{stdout}", 2000)


_REGISTRY: dict[str, Any] = {
    "web_search": web_search,
    "http_request": http_request,
    "boolab_rag": boolab_rag,
    "caldav_read": caldav_read,
    "file_read": file_read,
    "run_powershell": run_powershell,
}


def ollama_tool_schema(tool_id: str) -> dict[str, Any] | None:
    schemas: dict[str, dict[str, Any]] = {
        "web_search": {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web via SearXNG",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        },
        "http_request": {
            "type": "function",
            "function": {
                "name": "http_request",
                "description": "HTTP GET to an allowed URL",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "method": {"type": "string", "description": "GET or POST"},
                    },
                    "required": ["url"],
                },
            },
        },
        "boolab_rag": {
            "type": "function",
            "function": {
                "name": "boolab_rag",
                "description": "Query boolab RAG for a DAW",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        },
        "caldav_read": {
            "type": "function",
            "function": {
                "name": "caldav_read",
                "description": "Read upcoming calendar events (configured server)",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        "file_read": {
            "type": "function",
            "function": {
                "name": "file_read",
                "description": "Read a text file from sam-desktop (allowed paths only)",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        },
        "run_powershell": {
            "type": "function",
            "function": {
                "name": "run_powershell",
                "description": "Run whitelisted PowerShell on sam-desktop",
                "parameters": {
                    "type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"],
                },
            },
        },
    }
    return schemas.get(tool_id)


async def execute_tool(tool_id: str, config: dict[str, Any], args: dict[str, Any]) -> str:
    fn = _REGISTRY.get(tool_id)
    if not fn:
        return f"unknown tool: {tool_id}"
    try:
        return await fn(config, args)
    except Exception as e:
        return f"tool error: {e}"


def parse_tools_json(raw: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if isinstance(item, dict) and item.get("tool"):
            out.append({"tool": str(item["tool"]), "config": item.get("config") or {}})
    return out
