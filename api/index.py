"""Ornith OS — Vercel Python (FastAPI) entrypoint.

Exposes the JSON API under ``/api/*``. The static dashboard (``public/``) is
served directly by Vercel. All agent state lives in Neon Postgres; agent logic
runs in ``ornith_os``. Per-agent routes accept ``?agent_id=`` (default ``main``).

Vercel rewrites ``/api/(.*)`` to this function (see vercel.json), and the
FastAPI app routes on the original ``/api/...`` path.
"""

import logging
import os
import sys

# Make the repo-root `ornith_os` package importable from the serverless function.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from ornith_os import agent, db  # noqa: E402

logger = logging.getLogger("ornith_os")
app = FastAPI(title="Ornith OS")

DEFAULT_AGENT = "main"


def _agent_id(request):
    return request.query_params.get("agent_id", DEFAULT_AGENT)


def _auth(request):
    """Optional shared-secret gate for mutating/cost-incurring routes.

    Disabled by default. If ORNITH_API_TOKEN is set, callers must present it via
    `Authorization: Bearer <token>` or the `X-API-Token` header.
    """
    expected = os.environ.get("ORNITH_API_TOKEN")
    if not expected:
        return
    provided = request.headers.get("x-api-token") or ""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        provided = provided or auth[7:]
    if provided != expected:
        raise HTTPException(status_code=401, detail="unauthorized")


def _ready():
    """Ensure the schema exists; raises if DATABASE_URL is missing/unreachable."""
    db.init()


@app.get("/api/health")
def health():
    info = {"ok": True, "model_configured": bool(os.environ.get("ORNITH_BASE_URL"))}
    try:
        _ready()
        info["db"] = "ok"
    except Exception:  # noqa: BLE001 - report status without leaking config details
        logger.exception("Health check database readiness failed")
        info["db"] = "error"
        info["ok"] = False
    return info


@app.post("/api/chat")
async def chat(request: Request):
    _auth(request)
    _ready()
    data = await request.json()
    result = agent.run(
        _agent_id(request), data.get("session_id", "default"), data.get("message", "")
    )
    return result


@app.get("/api/history")
def history(request: Request):
    _ready()
    session_id = request.query_params.get("session_id", "default")
    rows = db.query(
        "SELECT role, content, reasoning, created_at FROM messages "
        "WHERE agent_id = %s AND session_id = %s ORDER BY id ASC",
        (_agent_id(request), session_id),
    )
    return {"messages": rows}


@app.get("/api/sessions")
def sessions(request: Request):
    _ready()
    rows = db.query(
        "SELECT session_id, COUNT(*) AS count, MAX(created_at) AS last "
        "FROM messages WHERE agent_id = %s GROUP BY session_id ORDER BY last DESC",
        (_agent_id(request),),
    )
    return {"sessions": rows}


@app.get("/api/config")
def get_config(request: Request):
    _ready()
    return agent.get_config(_agent_id(request))


@app.post("/api/config")
async def set_config(request: Request):
    _auth(request)
    _ready()
    data = await request.json()
    agent.set_config(
        _agent_id(request), name=data.get("name"), instructions=data.get("instructions")
    )
    return {"ok": True}


@app.get("/api/agents")
def list_agents():
    _ready()
    return {"agents": agent.list_agents()}


@app.post("/api/agents")
async def spawn_agent(request: Request):
    _auth(request)
    _ready()
    data = await request.json()
    new_id = agent.spawn_agent(data.get("name", "agent"), data.get("instructions", ""))
    return {"agent_id": new_id, "name": data.get("name", "agent")}


@app.post("/api/schedule")
async def schedule(request: Request):
    _auth(request)
    _ready()
    data = await request.json()
    try:
        every_minutes = int(data.get("every_minutes", 60))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="every_minutes must be an integer")
    if every_minutes < 1:
        raise HTTPException(status_code=400, detail="every_minutes must be at least 1")
    agent.schedule_task(_agent_id(request), data.get("prompt", ""), every_minutes)
    return {"ok": True}


@app.get("/api/tasks")
def tasks(request: Request):
    _ready()
    return {"tasks": agent.list_tasks(_agent_id(request))}


@app.post("/api/tick")
def tick(request: Request):
    """Cron endpoint: run every scheduled task that is due."""
    _auth(request)
    _ready()
    return {"ran": agent.run_due_tasks()}


@app.exception_handler(Exception)
async def on_error(request, exc):
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
    logger.exception("Unhandled API error")
    return JSONResponse(status_code=500, content={"error": "internal server error"})
