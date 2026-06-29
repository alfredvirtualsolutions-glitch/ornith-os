"""Agent core — the runtime logic for every agent, backed by D1.

This module replaces the former Agent/Kernel Durable Objects. Each agent is just
a set of rows in D1 keyed by ``agent_id``; the logic here is plain async
functions that the Worker calls in-process. That removes the Durable Object
requirement (and the paid-plan dependency) while keeping the same behaviour:
persistent memory and sessions, a tool-calling model loop, multi-agent
orchestration, and cron-driven scheduled tasks.
"""

import json
import time

import ornith
import store
import tools

DEFAULT_SYSTEM_PROMPT = (
    "You are an agent running inside Ornith OS, a durable multi-agent runtime on "
    "Cloudflare. You are powered by Ornith-1.0, a reasoning model. Think step by "
    "step, use the available tools when they help, and keep final answers concise. "
    "You can spawn and delegate to other agents when a task is better handled by a "
    "specialist."
)

MAX_TOOL_ITERATIONS = 5


def _now_ms():
    return int(time.time() * 1000)


def _slugify(name):
    safe = "".join(c if c.isalnum() else "-" for c in (name or "agent").lower())
    return safe.strip("-") or "agent"


# --- config / memory ---------------------------------------------------------


async def get_config(env, agent_id):
    rows = await store.query(
        env, "SELECT key, value FROM meta WHERE agent_id = ?", agent_id
    )
    meta = {r["key"]: r["value"] for r in rows}
    return {
        "name": meta.get("name", "main" if agent_id == "main" else agent_id),
        "instructions": meta.get("instructions", DEFAULT_SYSTEM_PROMPT),
    }


async def set_config(env, agent_id, name=None, instructions=None):
    for key, value in (("name", name), ("instructions", instructions)):
        if value is not None:
            await store.run(
                env,
                "INSERT INTO meta (agent_id, key, value) VALUES (?, ?, ?) "
                "ON CONFLICT(agent_id, key) DO UPDATE SET value = excluded.value",
                agent_id,
                key,
                value,
            )


async def _system_prompt(env, agent_id):
    cfg = await get_config(env, agent_id)
    return f"Your name is {cfg['name']}.\n\n{cfg['instructions']}"


async def _history(env, agent_id, session_id, limit=40):
    rows = await store.query(
        env,
        "SELECT role, content FROM messages WHERE agent_id = ? AND session_id = ? "
        "ORDER BY id DESC LIMIT ?",
        agent_id,
        session_id,
        limit,
    )
    rows.reverse()
    return [{"role": r["role"], "content": r["content"]} for r in rows]


async def _save(env, agent_id, session_id, role, content, reasoning=""):
    await store.run(
        env,
        "INSERT INTO messages (agent_id, session_id, role, content, reasoning, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        agent_id,
        session_id,
        role,
        content,
        reasoning,
        _now_ms(),
    )


# --- multi-agent orchestration -----------------------------------------------


async def spawn_agent(env, name, instructions, task=None):
    slug = _slugify(name)
    agent_id = f"{slug}-{_now_ms() % 100000}"
    await store.run(
        env,
        "INSERT INTO agents (agent_id, name, instructions, created_at) "
        "VALUES (?, ?, ?, ?)",
        agent_id,
        name,
        instructions,
        _now_ms(),
    )
    await set_config(env, agent_id, name=name, instructions=instructions)
    if task:
        await run(env, agent_id, "inbox", task, persist=False)
    return agent_id


async def list_agents(env):
    return await store.query(env, "SELECT * FROM agents ORDER BY created_at")


async def send_to_agent(env, agent_id, message):
    known = await store.first(env, "SELECT 1 AS ok FROM agents WHERE agent_id = ?", agent_id)
    if not known:
        return f"error: unknown agent '{agent_id}'"
    result = await run(env, agent_id, "inbox", message, persist=False)
    return result["content"]


# --- the model loop ----------------------------------------------------------


async def run(env, agent_id, session_id, user_message, persist=True):
    if persist:
        await _save(env, agent_id, session_id, "user", user_message)

    messages = [{"role": "system", "content": await _system_prompt(env, agent_id)}]
    messages.extend(await _history(env, agent_id, session_id))
    if not persist:
        messages.append({"role": "user", "content": user_message})

    # Orchestration callables injected into tool dispatch (in-process, no DO hop).
    async def _spawn(n, i, t=None):
        new_id = await spawn_agent(env, n, i, t)
        return f"spawned agent '{n}' with id {new_id}"

    async def _send(a, m):
        return await send_to_agent(env, a, m)

    async def _list():
        return await list_agents(env)

    ctx = {
        "env": env,
        "spawn_agent": _spawn,
        "send_to_agent": _send,
        "list_agents": _list,
    }

    final = {"content": "", "reasoning": "", "source": "", "steps": []}
    for _ in range(MAX_TOOL_ITERATIONS):
        result = await ornith.complete(env, messages, tools=tools.TOOLS)
        final["reasoning"] = result["reasoning"]
        final["source"] = result["source"]

        tool_calls = result.get("tool_calls") or []
        if not tool_calls:
            final["content"] = result["content"]
            break

        messages.append(
            {
                "role": "assistant",
                "content": result["content"],
                "tool_calls": [
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {
                            "name": c["name"],
                            "arguments": json.dumps(c["arguments"]),
                        },
                    }
                    for c in tool_calls
                ],
            }
        )
        for call in tool_calls:
            output = await tools.dispatch(call["name"], call["arguments"], ctx)
            final["steps"].append({"tool": call["name"], "output": output})
            messages.append(
                {"role": "tool", "tool_call_id": call["id"], "content": output}
            )
    else:
        if not final["content"]:
            final["content"] = "(stopped after too many tool steps)"

    if persist:
        await _save(env, agent_id, session_id, "assistant", final["content"], final["reasoning"])
    return final


# --- scheduled tasks (driven by the cron trigger) ----------------------------


async def schedule_task(env, agent_id, prompt, every_minutes, session_id="scheduled"):
    every = int(every_minutes)
    await store.run(
        env,
        "INSERT INTO tasks (agent_id, prompt, every_minutes, next_run, session_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        agent_id,
        prompt,
        every,
        _now_ms() + every * 60_000,
        session_id,
        _now_ms(),
    )


async def list_tasks(env, agent_id):
    return await store.query(
        env, "SELECT * FROM tasks WHERE agent_id = ? ORDER BY id", agent_id
    )


async def run_due_tasks(env):
    """Run every scheduled task whose next_run is in the past. Returns the count."""
    now = _now_ms()
    due = await store.query(env, "SELECT * FROM tasks WHERE next_run <= ?", now)
    for task in due:
        await run(env, task["agent_id"], task["session_id"], task["prompt"])
        await store.run(
            env,
            "UPDATE tasks SET next_run = ? WHERE id = ?",
            now + task["every_minutes"] * 60_000,
            task["id"],
        )
    return len(due)
