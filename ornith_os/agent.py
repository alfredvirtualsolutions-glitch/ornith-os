"""Agent core — runtime logic for every agent, backed by Neon Postgres.

Each agent is a set of rows keyed by ``agent_id``; the logic here is plain
(synchronous) functions the API layer calls directly. Provides persistent memory
and sessions, a tool-calling model loop, multi-agent orchestration, and
cron-driven scheduled tasks.
"""

import json
import time
import uuid

from . import db, model, tools

DEFAULT_SYSTEM_PROMPT = (
    "You are an agent running inside Ornith OS, a multi-agent runtime. You are "
    "powered by Ornith-1.0, a reasoning model. Think step by step, use the "
    "available tools when they help, and keep final answers concise. You can spawn "
    "and delegate to other agents when a task is better handled by a specialist."
)

MAX_TOOL_ITERATIONS = 5


def _now_ms():
    return int(time.time() * 1000)


def _slugify(name):
    safe = "".join(c if c.isalnum() else "-" for c in (name or "agent").lower())
    return safe.strip("-") or "agent"


# --- config / memory ---------------------------------------------------------


def get_config(agent_id):
    rows = db.query("SELECT key, value FROM meta WHERE agent_id = %s", (agent_id,))
    meta = {r["key"]: r["value"] for r in rows}
    return {
        "name": meta.get("name", agent_id),
        "instructions": meta.get("instructions", DEFAULT_SYSTEM_PROMPT),
    }


def set_config(agent_id, name=None, instructions=None):
    for key, value in (("name", name), ("instructions", instructions)):
        if value is not None:
            db.execute(
                "INSERT INTO meta (agent_id, key, value) VALUES (%s, %s, %s) "
                "ON CONFLICT (agent_id, key) DO UPDATE SET value = EXCLUDED.value",
                (agent_id, key, value),
            )


def _system_prompt(agent_id):
    cfg = get_config(agent_id)
    return f"Your name is {cfg['name']}.\n\n{cfg['instructions']}"


def _history(agent_id, session_id, limit=40):
    rows = db.query(
        "SELECT role, content FROM messages WHERE agent_id = %s AND session_id = %s "
        "ORDER BY id DESC LIMIT %s",
        (agent_id, session_id, limit),
    )
    rows.reverse()
    return [{"role": r["role"], "content": r["content"]} for r in rows]


def _save(agent_id, session_id, role, content, reasoning=""):
    db.execute(
        "INSERT INTO messages (agent_id, session_id, role, content, reasoning, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (agent_id, session_id, role, content, reasoning, _now_ms()),
    )


# --- multi-agent orchestration -----------------------------------------------


def spawn_agent(name, instructions, task=None):
    # Collision-resistant id (same-name agents in the same ms must not clash).
    agent_id = f"{_slugify(name)[:48]}-{uuid.uuid4().hex[:12]}"
    db.execute(
        "INSERT INTO agents (agent_id, name, instructions, created_at) "
        "VALUES (%s, %s, %s, %s)",
        (agent_id, name, instructions, _now_ms()),
    )
    set_config(agent_id, name=name, instructions=instructions)
    if task:
        run(agent_id, "inbox", task)
    return agent_id


def list_agents():
    return db.query("SELECT * FROM agents ORDER BY created_at")


def send_to_agent(agent_id, message):
    if not db.first("SELECT 1 AS ok FROM agents WHERE agent_id = %s", (agent_id,)):
        return f"error: unknown agent '{agent_id}'"
    return run(agent_id, "inbox", message)["content"]


# --- the model loop ----------------------------------------------------------


def run(agent_id, session_id, user_message, persist=True):
    if persist:
        _save(agent_id, session_id, "user", user_message)

    messages = [{"role": "system", "content": _system_prompt(agent_id)}]
    messages.extend(_history(agent_id, session_id))
    if not persist:
        messages.append({"role": "user", "content": user_message})

    def _spawn(n, i, t=None):
        return f"spawned agent '{n}' with id {spawn_agent(n, i, t)}"

    ctx = {
        "spawn_agent": _spawn,
        "send_to_agent": send_to_agent,
        "list_agents": list_agents,
    }

    final = {"content": "", "reasoning": "", "source": "", "steps": []}
    for _ in range(MAX_TOOL_ITERATIONS):
        result = model.complete(messages, tools=tools.TOOLS)
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
                        "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])},
                    }
                    for c in tool_calls
                ],
            }
        )
        for call in tool_calls:
            output = tools.dispatch(call["name"], call["arguments"], ctx)
            final["steps"].append({"tool": call["name"], "output": output})
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": output})
    else:
        if not final["content"]:
            final["content"] = "(stopped after too many tool steps)"

    if persist:
        _save(agent_id, session_id, "assistant", final["content"], final["reasoning"])
    return final


# --- scheduled tasks (driven by the /api/tick cron endpoint) -----------------


def schedule_task(agent_id, prompt, every_minutes, session_id="scheduled"):
    try:
        every = int(every_minutes)
    except (TypeError, ValueError) as exc:
        raise ValueError("every_minutes must be a positive integer") from exc
    if every <= 0:
        raise ValueError("every_minutes must be a positive integer")
    db.execute(
        "INSERT INTO tasks (agent_id, prompt, every_minutes, next_run, session_id, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (agent_id, prompt, every, _now_ms() + every * 60_000, session_id, _now_ms()),
    )


def list_tasks(agent_id):
    return db.query("SELECT * FROM tasks WHERE agent_id = %s ORDER BY id", (agent_id,))


def run_due_tasks():
    now = _now_ms()
    # Atomically claim due tasks (advance next_run) so concurrent ticks — the
    # Vercel cron and a manual /api/tick — never run the same task twice.
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE tasks "
                "SET next_run = %s + (every_minutes::BIGINT * 60000) "
                "WHERE next_run <= %s RETURNING *",
                (now, now),
            )
            due = [dict(row) for row in cur.fetchall()]
    for task in due:
        run(task["agent_id"], task["session_id"], task["prompt"])
    return len(due)
