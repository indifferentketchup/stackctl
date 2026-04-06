"""Shared inference HTTP base URL and SSE framing (agents, flows, flow runner)."""

from __future__ import annotations

import os


def _ollama_base() -> str:
    raw = (os.environ.get("OLLAMA_URL") or "").strip()
    if not raw:
        return "http://127.0.0.1:11434"
    return raw.rstrip("/")


def _sse(data: str) -> bytes:
    return f"data: {data}\n\n".encode("utf-8")
