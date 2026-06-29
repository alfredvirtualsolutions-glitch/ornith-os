"""Ornith OS — Worker entrypoint and HTTP router.

Serves the dashboard (static assets), exposes the JSON API, and runs the cron
tick. All agent state lives in D1 (``env.DB``); the agent logic runs in-process
via ``agent_core`` — no Durable Objects, so the whole OS works on the Workers
Free plan.

Per-agent routes accept ``?agent_id=`` (default ``main``).
"""

import json
from urllib.parse import urlparse, parse_qs

from workers import Response

import agent_core
import store

DEFAULT_AGENT = "main"


def _json(data, status=200):
    return Response(
        json.dumps(data),
        status=status,
        headers={"Content-Type": "application/json"},
    )


async def on_fetch(request, env, ctx):
    url = urlparse(request.url)
    path = url.path

    # Static assets / dashboard.
    if not path.startswith("/api/"):
        return await env.ASSETS.fetch(request)

    await store.init(env)

    query = parse_qs(url.query)
    agent_id = (query.get("agent_id") or [DEFAULT_AGENT])[0]
    method = request.method

    async def body():
        return (await request.json()).to_py()

    # --- fleet management ---
    if path == "/api/agents":
        if method == "POST":
            data = await body()
            new_id = await agent_core.spawn_agent(
                env, data.get("name", "agent"), data.get("instructions", "")
            )
            return _json({"agent_id": new_id, "name": data.get("name", "agent")})
        return _json({"agents": await agent_core.list_agents(env)})

    if path == "/api/tick" and method == "POST":
        return _json({"ran": await agent_core.run_due_tasks(env)})

    # --- per-agent ---
    if path.endswith("/chat") and method == "POST":
        data = await body()
        result = await agent_core.run(
            env, agent_id, data.get("session_id", "default"), data.get("message", "")
        )
        return _json(result)

    if path.endswith("/history") and method == "GET":
        session_id = (query.get("session_id") or ["default"])[0]
        rows = await store.query(
            env,
            "SELECT role, content, reasoning, created_at FROM messages "
            "WHERE agent_id = ? AND session_id = ? ORDER BY id ASC",
            agent_id,
            session_id,
        )
        return _json({"messages": rows})

    if path.endswith("/sessions") and method == "GET":
        rows = await store.query(
            env,
            "SELECT session_id, COUNT(*) AS count, MAX(created_at) AS last "
            "FROM messages WHERE agent_id = ? GROUP BY session_id ORDER BY last DESC",
            agent_id,
        )
        return _json({"sessions": rows})

    if path.endswith("/config"):
        if method == "POST":
            data = await body()
            await agent_core.set_config(
                env, agent_id, name=data.get("name"), instructions=data.get("instructions")
            )
            return _json({"ok": True})
        return _json(await agent_core.get_config(env, agent_id))

    if path.endswith("/schedule") and method == "POST":
        data = await body()
        await agent_core.schedule_task(
            env, agent_id, data.get("prompt", ""), data.get("every_minutes", 60)
        )
        return _json({"ok": True})

    if path.endswith("/tasks") and method == "GET":
        return _json({"tasks": await agent_core.list_tasks(env, agent_id)})

    return _json({"error": "not found", "path": path}, status=404)


async def on_scheduled(event, env, ctx):
    """Cron tick: run every scheduled task that is due."""
    await store.init(env)
    await agent_core.run_due_tasks(env)
