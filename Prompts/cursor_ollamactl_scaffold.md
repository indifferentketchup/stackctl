# Cursor Prompt — ollamactl Scaffold Setup

## Context
You are scaffolding a brand new project called **ollamactl** from scratch. This is a self-hosted Ollama control plane. Read `README.md` before doing anything.

---

## Mandatory pre-work
Read `README.md` in full before writing any code.

---

## What to generate

### Project structure
```
/opt/ollamactl/
├── README.md                    (already exists)
├── docker-compose.yml
├── .env.example
├── Dockerfile.backend
├── Dockerfile.frontend
├── backend/
│   ├── main.py
│   ├── db.py
│   ├── auth_deps.py
│   ├── routers/
│   │   └── ollama.py            (stub — Phase 1 fills this)
│   └── requirements.txt
└── frontend/
    ├── package.json
    ├── vite.config.js
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── index.css
        ├── api/
        │   └── ollama.js        (stub)
        ├── components/
        │   └── layout/
        │       └── Sidebar.jsx  (stub)
        └── pages/
            └── HomePage.jsx     (stub)
```

---

## `docker-compose.yml`

```yaml
services:
  ollamactl-api:
    build:
      context: .
      dockerfile: Dockerfile.backend
    container_name: ollamactl_api
    restart: unless-stopped
    ports:
      - "100.114.205.53:8700:8700"
    volumes:
      - /docker/ollamactl:/data
    env_file:
      - .env
    networks:
      - ollamactl_net

  ollamactl-ui:
    build:
      context: .
      dockerfile: Dockerfile.frontend
    container_name: ollamactl_ui
    restart: unless-stopped
    ports:
      - "100.114.205.53:8701:80"
    networks:
      - ollamactl_net

networks:
  ollamactl_net:
    driver: bridge
```

---

## `.env.example`

```
OLLAMA_URL=http://100.101.41.16:11434
BOOLAB_API_URL=http://100.114.205.53:9300
BOOLAB_OWNER_TOKEN=
CHROMA_URL=http://100.114.205.53:8000
SEARXNG_URL=http://100.114.205.53:8888
CALDAV_URL=http://100.114.205.53:5232/dav.php
DB_PATH=/data/ollamactl.db
JWT_SECRET=changeme
```

---

## `Dockerfile.backend`

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8700"]
```

---

## `Dockerfile.frontend`

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

---

## `backend/requirements.txt`

```
fastapi==0.115.0
uvicorn[standard]==0.30.0
httpx==0.27.0
python-multipart==0.0.9
pydantic==2.7.0
aiosqlite==0.20.0
python-jose[cryptography]==3.3.0
```

---

## `backend/main.py`

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import ollama
from db import init_db
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ollama.router, prefix="/api/ollama")
```

---

## `backend/db.py`

```python
import aiosqlite
import os

DB_PATH = os.environ.get("DB_PATH", "/data/ollamactl.db")

async def get_db():
    return await aiosqlite.connect(DB_PATH)

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS gpu_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS rag_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()
```

---

## `backend/auth_deps.py`

```python
import os
from fastapi import Depends, HTTPException, Header
from typing import Optional

JWT_SECRET = os.environ.get("JWT_SECRET", "changeme")

async def require_admin(authorization: Optional[str] = Header(None)):
    # Simple token check — Tailscale handles real auth
    # Just verify a bearer token is present and non-empty
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {"authorized": True}
```

---

## `backend/routers/ollama.py`

Stub only — Phase 1 fills this out:

```python
from fastapi import APIRouter, Depends
from auth_deps import require_admin
import os, httpx

router = APIRouter()

def _ollama_base():
    return os.environ.get("OLLAMA_URL", "http://100.101.41.16:11434").rstrip("/")

@router.get("/models")
async def list_models():
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{_ollama_base()}/api/tags")
        r.raise_for_status()
    return r.json()
```

---

## `frontend/package.json`

```json
{
  "name": "ollamactl",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0",
    "@tanstack/react-query": "^5.56.0",
    "lucide-react": "^0.447.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.3",
    "class-variance-authority": "^0.7.0",
    "reactflow": "^11.11.4"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.6",
    "tailwindcss": "^3.4.12",
    "postcss": "^8.4.47",
    "autoprefixer": "^10.4.20"
  }
}
```

---

## `frontend/vite.config.js`

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8700',
    },
  },
})
```

---

## `frontend/tailwind.config.js`

Configure dark mode + shadcn/ui compatible theme. Match boolab's CSS variable approach:
- `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `border`, `ring`, `destructive`
- Dark mode: class-based

---

## `frontend/src/index.css`

Dark theme CSS variables matching boolab's palette:
- Background: near-black (`oklch(0.145 0 0)`)
- Accent/primary: magenta/pink (`#e91e8c` family)
- Card: slightly lighter dark
- All standard shadcn/ui variable names

Import Rajdhani and Share Tech Mono from Google Fonts.

---

## `frontend/src/App.jsx`

React Router setup with routes:
```
/              → HomePage (dashboard)
/models        → stub (Phase 1)
/running       → stub (Phase 1)
/models/create → stub (Phase 2)
/models/:name  → stub (Phase 2)
/import        → stub (Phase 4)
/personas      → stub (Phase 3)
/gpu           → stub (Phase 5)
/rag           → stub (Phase 6)
/agents        → stub (Phase 7)
/agents/new    → stub (Phase 7)
/agents/:id    → stub (Phase 7)
/flows         → stub (Phase 8)
/flows/new     → stub (Phase 8)
/flows/:id     → stub (Phase 8)
```

Layout: `Sidebar` + `<Outlet />`

---

## `frontend/src/pages/HomePage.jsx`

Dashboard landing page matching webollama's home page layout but with boolab's dark cyberpunk aesthetic.

Cards:
- Models → /models
- Running Models → /running
- Create Model → /models/create
- Import Model → /import
- Personas → /personas
- Multi-GPU → /gpu
- RAG → /rag
- Agents → /agents
- Flows → /flows

Each card: icon, title, description, action button.

Header: "ollamactl" + Ollama version badge (fetched from `/api/ollama/version` stub)

---

## `frontend/src/components/layout/Sidebar.jsx`

Left sidebar with nav items matching the route structure above. Stubbed items show "(soon)" label and are `opacity-50 pointer-events-none`.

Active state via React Router `useLocation`.

Bottom: Ollama connection status indicator (green dot if reachable, red if not — polls `/api/ollama/models` every 30s).

---

## `frontend/nginx.conf`

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    location /api/ {
        proxy_pass http://ollamactl_api:8700;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
    }
}
```

---

## Constraints
- shadcn/ui components: install via CLI after scaffold or copy from boolab's `src/components/ui/` — do not regenerate from scratch
- The scaffold must build and run with `docker compose up --build -d` before Phase 1 work begins
- All stub pages show a simple "Coming soon — Phase N" placeholder
- Do not implement any actual Ollama API calls beyond the basic `/models` stub — Phase 1 handles that
