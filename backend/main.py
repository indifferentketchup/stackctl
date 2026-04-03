"""ollamactl API — Ollama control plane backend."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import init_db
from routers import agents, flows, gpu, machines, modelfile_apply, ollama, personas

load_dotenv()
logging.basicConfig(level=logging.INFO)


def _cors_origins() -> list[str]:
    raw = [o.strip() for o in os.environ.get("FRONTEND_ORIGIN", "").split(",") if o.strip()]
    if not raw:
        return ["*"]
    return raw


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="ollamactl API", lifespan=lifespan)

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
api.include_router(ollama.router, prefix="/ollama", tags=["ollama"])
api.include_router(modelfile_apply.router, prefix="/models", tags=["models"])
api.include_router(machines.router, prefix="/machines", tags=["machines"])
api.include_router(gpu.router, prefix="/gpu", tags=["gpu"])
api.include_router(personas.router, prefix="/personas", tags=["personas"])
api.include_router(agents.router, prefix="/agents", tags=["agents"])
api.include_router(flows.router, prefix="/flows", tags=["flows"])
app.include_router(api)


@app.get("/api/health")
async def api_health():
    return {"status": "ok"}
