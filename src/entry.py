"""Ornith OS — Worker entrypoint and HTTP router.

This is the front door. It serves the dashboard (static assets), exposes a small
JSON API, and forwards work to the right Durable Object:

* per-agent routes (chat, history, sessions, config, schedule, tasks) go to an
  ``Agent`` instance addressed by ``?agent_id=`` (default: ``main``);
* fleet routes (list / spawn agents, manual tick) go to the single ``Kernel``.

The ``Agent`` and ``Kernel`` classes are imported here so the Workers runtime
can find them by the ``class_name`` declared in wrangler.jsonc. The scheduled
handler fans the cron tick out through the Kernel and the default agent.
"""

import json
from urllib.parse import urlparse, parse_qs

from workers import Response

import ornith
from agent import Agent  # noqa: F401 - exported as a Durable Object class
from kernel import Kernel  # noqa: F401 - exported as a Durable Object class

KERNEL_NAME = "ornith-kernel"
DEFAULT_AGENT = "main"

# Per-agent API routes forwarded straight to the addressed Agent Durable Object.
# The Agent matches on the path suffix, so /api/chat -> its "/chat" handler.
_AGENT_ROUTES = ("/chat", "/history", "/sessions", "/config", "/schedule", "/tasks")


def _agent_stub(env, agent_id):
    ns = env.AGENT
    return ns.get(ns.idFromName(agent_id))


def _kernel_stub(env):
    ns = env.KERNEL
    return ns.get(ns.idFromName(KERNEL_NAME))


async def _passthrough(resp):
    """Re-wrap a Durable Object's JS Response as a Python Worker Response."""
    text = await resp.text()
    return Response(
        text,
        status=resp.status,
        headers={"Content-Type": "application/json"},
    )


async def _call_do(stub, path, method="GET", body=None):
    init = {"method": method, "headers": {"content-type": "application/json"}}
    if body is not None:
        init["body"] = json.dumps(body)
    return await _passthrough(await stub.fetch("https://do" + path, ornith._to_js(init)))


async def on_fetch(request, env, ctx):
    url = urlparse(request.url)
    path = url.path

    # Static assets / dashboard.
    if not path.startswith("/api/"):
        return await env.ASSETS.fetch(request)

    query = parse_qs(url.query)
    agent_id = (query.get("agent_id") or [DEFAULT_AGENT])[0]
    method = request.method

    # Fleet management — the Kernel.
    if path == "/api/agents":
        if method == "POST":
            data = (await request.json()).to_py()
            return await _call_do(
                _kernel_stub(env),
                "/spawn",
                method="POST",
                body={
                    "name": data.get("name", "agent"),
                    "instructions": data.get("instructions", ""),
                },
            )
        return await _call_do(_kernel_stub(env), "/list", method="GET")

    if path == "/api/tick" and method == "POST":
        return await _call_do(_kernel_stub(env), "/tick", method="POST")

    # Per-agent routes — forward the original request to the Agent DO, which
    # matches on the path suffix (e.g. /api/chat -> /chat).
    for route in _AGENT_ROUTES:
        if path.endswith(route):
            return await _passthrough(await _agent_stub(env, agent_id).fetch(request))

    return Response(
        json.dumps({"error": "not found", "path": path}),
        status=404,
        headers={"Content-Type": "application/json"},
    )


async def on_scheduled(event, env, ctx):
    """Cron tick: run due scheduled tasks across the fleet and the main agent."""
    await _call_do(_kernel_stub(env), "/tick", method="POST")
    # The default agent isn't spawned through the Kernel, so tick it directly.
    await _call_do(_agent_stub(env, DEFAULT_AGENT), "/tick", method="POST")
