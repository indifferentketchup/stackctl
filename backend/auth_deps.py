"""Admin guard: Bearer token must match BOOLAB_OWNER_TOKEN (boolab owner JWT)."""

from __future__ import annotations

import os

from fastapi import Header, HTTPException

_SKIP = (os.environ.get("OLLAMACTL_SKIP_AUTH") or "").strip().lower() in (
    "1",
    "true",
    "yes",
)


async def require_admin(authorization: str | None = Header(None)) -> dict:
    if _SKIP:
        return {"sub": "dev-skip-auth"}

    expected = (os.environ.get("BOOLAB_OWNER_TOKEN") or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="BOOLAB_OWNER_TOKEN is not configured on the server",
        )

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization bearer token")

    token = authorization.removeprefix("Bearer ").strip()
    if not token or token != expected:
        raise HTTPException(status_code=403, detail="Invalid admin token")

    return {"sub": "owner"}
