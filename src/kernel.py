"""The Kernel Durable Object — the multi-agent orchestrator.

There is a single Kernel instance (addressed by the fixed name
``ornith-kernel``). It is the OS scheduler / process table: it keeps the
registry of every agent that has been spawned, routes messages between agents,
and fans out the cron tick so each agent runs its due scheduled tasks.

The Kernel never runs a model itself — it only coordinates Agent Durable
Objects, each of which owns its own state.
"""

import json
import time

from workers import DurableObject, Response

import ornith


def _json_response(data, status=200):
    return Response(
        json.dumps(data),
        status=status,
        headers={"Content-Type": "application/json"},
    )


def _slugify(name):
    safe = "".join(c if c.isalnum() else "-" for c in (name or "agent").lower())
    return safe.strip("-") or "agent"


class Kernel(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.ctx = ctx
        self.env = env
        self.ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS agents ("
            "agent_id TEXT PRIMARY KEY, "
            "name TEXT NOT NULL, "
            "instructions TEXT NOT NULL, "
            "created_at INTEGER NOT NULL)"
        )

    def _query(self, query, *params):
        cursor = self.ctx.storage.sql.exec(query, *params)
        return [row.to_py() for row in cursor.toArray()]

    def _agent_stub(self, agent_id):
        ns = self.env.AGENT
        return ns.get(ns.idFromName(agent_id))

    async def _agent_call(self, agent_id, path, method="POST", body=None):
        init = {"method": method, "headers": {"content-type": "application/json"}}
        if body is not None:
            init["body"] = json.dumps(body)
        resp = await self._agent_stub(agent_id).fetch(
            "https://agent" + path, ornith._to_js(init)
        )
        return (await resp.json()).to_py()

    def _register(self, name, instructions):
        slug = _slugify(name)
        agent_id = f"{slug}-{int(time.time() * 1000) % 100000}"
        self.ctx.storage.sql.exec(
            "INSERT INTO agents (agent_id, name, instructions, created_at) "
            "VALUES (?, ?, ?, ?)",
            agent_id,
            name,
            instructions,
            int(time.time() * 1000),
        )
        return agent_id

    async def on_fetch(self, request):
        from urllib.parse import urlparse

        path = urlparse(request.url).path
        method = request.method

        async def body():
            return (await request.json()).to_py()

        if path.endswith("/spawn") and method == "POST":
            data = await body()
            name = data.get("name", "agent")
            instructions = data.get("instructions", "")
            agent_id = self._register(name, instructions)
            # Push identity + system prompt into the new agent's own storage.
            await self._agent_call(
                agent_id, "/config", body={"name": name, "instructions": instructions}
            )
            return _json_response({"agent_id": agent_id, "name": name})

        if path.endswith("/route") and method == "POST":
            data = await body()
            agent_id = data.get("agent_id", "")
            known = self._query(
                "SELECT 1 FROM agents WHERE agent_id = ?", agent_id
            )
            if not known:
                return _json_response({"error": f"unknown agent '{agent_id}'"}, status=404)
            result = await self._agent_call(
                agent_id, "/receive", body={"message": data.get("message", "")}
            )
            return _json_response(result)

        if path.endswith("/list") and method == "GET":
            return _json_response(
                {"agents": self._query("SELECT * FROM agents ORDER BY created_at")}
            )

        if path.endswith("/tick") and method == "POST":
            # Cron fan-out: tell every registered agent to run its due tasks.
            ran = 0
            for agent in self._query("SELECT agent_id FROM agents"):
                try:
                    result = await self._agent_call(agent["agent_id"], "/tick")
                    ran += int(result.get("ran", 0))
                except Exception:  # noqa: BLE001 - one bad agent shouldn't stop the tick
                    continue
            return _json_response({"agents_ticked": True, "tasks_ran": ran})

        return _json_response({"error": "not found", "path": path}, status=404)
