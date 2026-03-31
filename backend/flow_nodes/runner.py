"""Execute flow definitions (sequential walk from input node)."""

from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any

import aiosqlite
import httpx

from db import DB_PATH
from routers.ollama import _ollama_base
from sam_ssh import connect_sam_desktop, iter_ssh_cmd_lines, powershell_single_quote, remote_temp_modelfile_path, ssh_remove_file, ssh_write_file
from tools.registry import execute_tool

_CTX_KEY = "_last_text"


def _node_map(defn: dict[str, Any]) -> dict[str, dict[str, Any]]:
    nodes = defn.get("nodes") or []
    out: dict[str, dict[str, Any]] = {}
    for n in nodes:
        if isinstance(n, dict) and n.get("id"):
            out[str(n["id"])] = n
    return out


def _edges(defn: dict[str, Any]) -> list[dict[str, Any]]:
    e = defn.get("edges") or []
    return [x for x in e if isinstance(x, dict)]


def _find_input_node(defn: dict[str, Any]) -> str | None:
    for nid, n in _node_map(defn).items():
        data = n.get("data") or {}
        kind = str(data.get("kind") or data.get("type") or "").lower()
        if kind == "input":
            return nid
    return None


def _next_target(edges: list[dict[str, Any]], from_id: str, cond_result: bool | None) -> str | None:
    outs = [e for e in edges if str(e.get("source")) == from_id]
    if not outs:
        return None
    if len(outs) == 1:
        return str(outs[0].get("target"))
    want = "true" if cond_result else "false"
    for e in outs:
        h = str(e.get("sourceHandle") or "").lower()
        if h == want:
            return str(e.get("target"))
    return str(outs[0].get("target"))


def _resolve_input_text(cfg: dict[str, Any], ctx: dict[str, Any]) -> str:
    if ctx.get("input") is not None:
        return str(ctx["input"])
    return str(cfg.get("text") or "")


async def _run_llm(cfg: dict[str, Any], text: str) -> str:
    base = _ollama_base() + "/api/chat"
    sys_prompt = str(cfg.get("system_prompt") or "You are a helpful assistant.")
    payload = {
        "model": str(cfg.get("model") or "llama3.2"),
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": text},
        ],
        "stream": False,
        "options": {
            "temperature": float(cfg.get("temperature") or 0.6),
            "top_k": int(cfg.get("top_k") or 20),
            "top_p": float(cfg.get("top_p") or 0.95),
            "num_ctx": int(cfg.get("num_ctx") or 8192),
        },
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        r = await client.post(base, json=payload)
    if r.status_code >= 400:
        raise RuntimeError(r.text[:1000])
    data = r.json()
    msg = data.get("message") if isinstance(data, dict) else None
    if isinstance(msg, dict):
        return str(msg.get("content") or "")
    return ""


def _eval_condition(cfg: dict[str, Any], text: str) -> bool:
    ct = str(cfg.get("condition_type") or "contains").lower()
    cv = str(cfg.get("condition_value") or "")
    if ct == "contains":
        return cv in text
    if ct == "starts_with":
        return text.startswith(cv)
    if ct == "regex":
        return bool(re.search(cv, text))
    if ct == "length_gt":
        try:
            return len(text) > int(cv)
        except ValueError:
            return False
    return False


async def _run_ssh_command(cfg: dict[str, Any]) -> dict[str, Any]:
    cmd = str(cfg.get("command") or "").strip()
    allowed = cfg.get("allowed_command_prefixes") or cfg.get("allowed_commands") or []
    if isinstance(allowed, str):
        allowed = [allowed]
    allowed = [str(x) for x in allowed if str(x).strip()]
    if not cmd or not allowed or not any(cmd.startswith(p) for p in allowed):
        return {"stdout": "", "stderr": "command not allowed", "exit_code": -1}
    ps = "powershell -NoProfile -Command " + powershell_single_quote(cmd)
    conn = None
    lines: list[str] = []
    code = -1
    try:
        conn = await connect_sam_desktop()
        async for text, ec in iter_ssh_cmd_lines(conn, ps):
            if text == "__end__":
                code = ec if ec is not None else -1
                break
            if text:
                lines.append(text)
        return {"stdout": "\n".join(lines), "stderr": "", "exit_code": int(code)}
    finally:
        if conn:
            conn.close()
            await conn.wait_closed()


async def _run_ollama_create(cfg: dict[str, Any]) -> dict[str, Any]:
    name = str(cfg.get("model_name") or "").strip()
    mf = str(cfg.get("modelfile_content") or "")
    if not name or not mf.strip():
        return {"success": False, "model_name": name}
    fname = f"flow_{uuid.uuid4().hex}.txt"
    conn = None
    remote = ""
    try:
        conn = await connect_sam_desktop()
        remote = await remote_temp_modelfile_path(conn, fname)
        await ssh_write_file(conn, remote, mf)
        inner = f"ollama create {name} -f {remote}"
        ps = "powershell -NoProfile -Command " + powershell_single_quote(inner)
        exit_c: int | None = None
        async for text, code in iter_ssh_cmd_lines(conn, ps):
            if text == "__end__":
                exit_c = code
                break
        ok = exit_c == 0
        return {"success": ok, "model_name": name}
    finally:
        if conn:
            if remote:
                await ssh_remove_file(conn, remote)
            conn.close()
            await conn.wait_closed()


async def _run_http(cfg: dict[str, Any], text: str) -> dict[str, Any]:
    tpl = str(cfg.get("body_template") or "")
    body = tpl.replace("{{input}}", text) if tpl else str(cfg.get("body") or "")
    url = str(cfg.get("url") or "")
    method = str(cfg.get("method") or "GET").upper()
    if not url:
        return {"status": 0, "body": "missing url"}
    allowed = cfg.get("allowed_domains") or []
    if isinstance(allowed, str):
        allowed = [x.strip() for x in allowed.split(",")]
    # Skip strict domain check if empty
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.request(method, url, content=body if body else None)
        return {"status": r.status_code, "body": r.text[:8000]}
    except Exception as e:
        return {"status": 0, "body": str(e)}


async def run_node(
    kind: str,
    cfg: dict[str, Any],
    ctx: dict[str, Any],
) -> tuple[Any, bool | None]:
    """Returns (output_value, condition_branch_or_None)."""
    text_in = str(ctx.get(_CTX_KEY) or ctx.get("input") or "")

    k = kind.lower()
    if k == "input":
        out = _resolve_input_text(cfg, ctx)
        ctx[_CTX_KEY] = out
        return out, None

    if k == "transform":
        tpl = str(cfg.get("template") or "{{input}}")
        out = tpl.replace("{{input}}", text_in)
        ctx[_CTX_KEY] = out
        return out, None

    if k == "llm":
        out = await _run_llm(cfg, text_in)
        ctx[_CTX_KEY] = out
        return out, None

    if k == "agent":
        aid = str(cfg.get("agent_id") or "").strip()
        if not aid:
            raise RuntimeError("agent_id required")
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT model, system_prompt, temperature, top_k, top_p, num_ctx FROM agents WHERE id = ?",
                (aid,),
            ) as cur:
                row = await cur.fetchone()
        if not row:
            raise RuntimeError("agent not found")
        cfg_llm = {
            "model": row[0],
            "system_prompt": row[1],
            "temperature": row[2],
            "top_k": row[3],
            "top_p": row[4],
            "num_ctx": row[5],
        }
        out = await _run_llm(cfg_llm, text_in)
        ctx[_CTX_KEY] = out
        return out, None

    if k == "tool":
        tid = str(cfg.get("tool_id") or "").strip()
        tcfg = cfg.get("tool_config") or cfg.get("config") or {}
        if not isinstance(tcfg, dict):
            tcfg = {}
        args = cfg.get("tool_params") if isinstance(cfg.get("tool_params"), dict) else {}
        raw = await execute_tool(tid, tcfg, {**args, "query": text_in, "q": text_in, "url": text_in})
        ctx[_CTX_KEY] = raw
        return raw, None

    if k == "condition":
        res = _eval_condition(cfg, text_in)
        ctx[_CTX_KEY] = text_in
        ctx["_condition"] = res
        return ("true" if res else "false"), res

    if k == "http":
        out = await _run_http(cfg, text_in)
        blob = json.dumps(out, ensure_ascii=False)
        ctx[_CTX_KEY] = blob
        return blob, None

    if k in ("ssh_command", "ssh"):
        out = await _run_ssh_command(cfg)
        blob = json.dumps(out, ensure_ascii=False)
        ctx[_CTX_KEY] = blob
        return blob, None

    if k in ("ollama_create", "ollama_create_node"):
        out = await _run_ollama_create(cfg)
        blob = json.dumps(out, ensure_ascii=False)
        ctx[_CTX_KEY] = blob
        return blob, None

    if k == "output":
        ctx["output"] = text_in
        return text_in, None

    ctx[_CTX_KEY] = text_in
    return text_in, None


def ssh_node_kinds(defn: dict[str, Any]) -> bool:
    for n in defn.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        data = n.get("data") or {}
        kind = str(data.get("kind") or data.get("type") or "").lower()
        if kind in ("ssh_command", "ssh", "ollama_create", "ollama_create_node"):
            return True
    return False


async def run_flow_linear(
    defn: dict[str, Any],
    input_text: str,
    trace: list[dict[str, Any]],
) -> str:
    nodes = _node_map(defn)
    edges = _edges(defn)
    start = _find_input_node(defn)
    if not start:
        raise ValueError("flow has no input node")
    ctx: dict[str, Any] = {"input": input_text, _CTX_KEY: input_text}
    cur: str | None = start
    final_out = ""

    while cur:
        node = nodes.get(cur)
        if not node:
            break
        data = node.get("data") or {}
        kind = str(data.get("kind") or data.get("type") or "transform")
        label = str(data.get("label") or kind)
        t0 = time.monotonic()
        err: str | None = None
        out_v: Any = None
        cond: bool | None = None
        try:
            out_v, cond = await run_node(kind, data, ctx)
        except Exception as e:
            err = str(e)
            trace.append(
                {
                    "node_id": cur,
                    "node_type": kind,
                    "node_label": label,
                    "status": "error",
                    "error": err,
                    "duration_ms": int((time.monotonic() - t0) * 1000),
                }
            )
            raise
        ms = int((time.monotonic() - t0) * 1000)
        trace.append(
            {
                "node_id": cur,
                "node_type": kind,
                "node_label": label,
                "status": "ok",
                "output": out_v if isinstance(out_v, str) else json.dumps(out_v)[:4000],
                "duration_ms": ms,
            }
        )
        if kind.lower() == "output":
            final_out = str(out_v or ctx.get("output") or "")

        cur = _next_target(edges, cur, cond)
    return final_out or str(ctx.get(_CTX_KEY) or "")
