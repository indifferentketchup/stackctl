"""stackctl API — homelab AI inference control plane (Bifrost + llama-swap)."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import init_db
from routers import agents, bifrost, flows, machines, model_catalog, ollama_proxy, personas

load_dotenv()
logging.basicConfig(level=logging.INFO)
logging.info("PROMETHEUS_URL=%s", (os.environ.get("PROMETHEUS_URL") or "http://100.114.205.53:9090").strip())


def _cors_origins() -> list[str]:
    raw = [o.strip() for o in os.environ.get("FRONTEND_ORIGIN", "").split(",") if o.strip()]
    if not raw:
        return ["*"]
    return raw


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    await ollama_proxy.startup_http_client()
    yield
    await ollama_proxy.shutdown_http_client()


app = FastAPI(title="stackctl API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


api = APIRouter(prefix="/api")
api.include_router(machines.router, prefix="/machines", tags=["machines"])
api.include_router(model_catalog.router, prefix="/models", tags=["models"])
api.include_router(bifrost.router, prefix="/bifrost", tags=["bifrost"])
api.include_router(personas.router, prefix="/personas", tags=["personas"])
api.include_router(agents.router, prefix="/agents", tags=["agents"])
api.include_router(flows.router, prefix="/flows", tags=["flows"])
app.include_router(api)
app.include_router(ollama_proxy.router, prefix="/ollama", tags=["ollama-http-proxy"])


@app.get("/api/health")
async def api_health():
    return {"status": "ok"}
