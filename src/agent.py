"""The Agent Durable Object — one durable, stateful agent instance.

Each Agent is a Durable Object with its own SQLite database, so its memory,
sessions, configuration, and scheduled tasks survive restarts and live close to
where it's used. An Agent:

* persists conversation history per session (``messages`` table),
* stores its identity / system prompt (``meta`` table),
* runs the model loop (Ornith-1.0 or the Workers AI fallback) with tool calling,
* schedules recurring work via Durable Object alarms (``tasks`` table),
* talks to sibling agents through the Kernel for multi-agent orchestration.

Durable Objects are addressed by name from the Worker, so the URL path
``/a/<agent_id>/...`` always routes to the same instance.
"""

import json
import time

from workers import DurableObject, Response

import ornith
import tools

DEFAULT_SYSTEM_PROMPT = (
    "You are an agent running inside Ornith OS, a durable multi-agent runtime on "
    "Cloudflare. You are powered by Ornith-1.0, a reasoning model. Think step by "
    "step, use the available tools when they help, and keep final answers concise. "
    "You can spawn and delegate to other agents when a task is better handled by a "
    "specialist."
)

MAX_TOOL_ITERATIONS = 5


def _json_response(data, status=200):
    return Response(
        json.dumps(data),
        status=status,
        headers={"Content-Type": "application/json"},
    )


def _now_ms():
    return int(time.time() * 1000)


class Agent(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.ctx = ctx
        self.env = env
        self._init_schema()

    # --- storage helpers -------------------------------------------------------

    def _init_schema(self):
        sql = self.ctx.storage.sql
        sql.exec(
            "CREATE TABLE IF NOT EXISTS messages ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "session_id TEXT NOT NULL, "
            "role TEXT NOT NULL, "
            "content TEXT NOT NULL, "
            "reasoning TEXT DEFAULT '', "
            "created_at INTEGER NOT NULL)"
        )
        sql.exec(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        sql.exec(
            "CREATE TABLE IF NOT EXISTS tasks ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "prompt TEXT NOT NULL, "
            "every_minutes INTEGER NOT NULL, "
            "next_run INTEGER NOT NULL, "
            "session_id TEXT NOT NULL DEFAULT 'scheduled', "
            "created_at INTEGER NOT NULL)"
        )

    def _query(self, query, *params):
        cursor = self.ctx.storage.sql.exec(query, *params)
        return [row.to_py() for row in cursor.toArray()]

    def _exec(self, query, *params):
        self.ctx.storage.sql.exec(query, *params)

    def _get_meta(self, key, default=None):
        rows = self._query("SELECT value FROM meta WHERE key = ?", key)
        return rows[0]["value"] if rows else default

    def _set_meta(self, key, value):
        self._exec(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            key,
            value,
        )

    def _system_prompt(self):
        name = self._get_meta("name", "Ornith Agent")
        instructions = self._get_meta("instructions", DEFAULT_SYSTEM_PROMPT)
        return f"Your name is {name}.\n\n{instructions}"

    def _history(self, session_id, limit=40):
        rows = self._query(
            "SELECT role, content FROM messages WHERE session_id = ? "
            "ORDER BY id DESC LIMIT ?",
            session_id,
            limit,
        )
        rows.reverse()
        return [{"role": r["role"], "content": r["content"]} for r in rows]

    def _save(self, session_id, role, content, reasoning=""):
        self._exec(
            "INSERT INTO messages (session_id, role, content, reasoning, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            session_id,
            role,
            content,
            reasoning,
            _now_ms(),
        )

    # --- orchestration callables (injected into tool dispatch) -----------------

    def _kernel(self):
        ns = self.env.KERNEL
        return ns.get(ns.idFromName("ornith-kernel"))

    async def _kernel_call(self, path, method="POST", body=None):
        options = _to_js_init(method, body)
        resp = await self._kernel().fetch("https://kernel" + path, options)
        return (await resp.json()).to_py()

    async def _spawn_agent(self, name, instructions, task=None):
        result = await self._kernel_call(
            "/spawn", body={"name": name, "instructions": instructions}
        )
        agent_id = result.get("agent_id", "")
        if task and agent_id:
            await self._send_to_agent(agent_id, task)
        return f"spawned agent '{name}' with id {agent_id}"

    async def _send_to_agent(self, agent_id, message):
        result = await self._kernel_call(
            "/route", body={"agent_id": agent_id, "message": message}
        )
        return result.get("reply", result.get("error", "no reply"))

    async def _list_agents(self):
        result = await self._kernel_call("/list", method="GET")
        return result.get("agents", [])

    # --- the model loop --------------------------------------------------------

    async def _run(self, session_id, user_message, persist=True):
        if persist:
            self._save(session_id, "user", user_message)

        messages = [{"role": "system", "content": self._system_prompt()}]
        messages.extend(self._history(session_id))
        if not persist:
            messages.append({"role": "user", "content": user_message})

        ctx = {
            "env": self.env,
            "spawn_agent": self._spawn_agent,
            "send_to_agent": self._send_to_agent,
            "list_agents": self._list_agents,
        }

        final = {"content": "", "reasoning": "", "source": "", "steps": []}
        for _ in range(MAX_TOOL_ITERATIONS):
            result = await ornith.complete(self.env, messages, tools=tools.TOOLS)
            final["reasoning"] = result["reasoning"]
            final["source"] = result["source"]

            tool_calls = result.get("tool_calls") or []
            if not tool_calls:
                final["content"] = result["content"]
                break

            # Record the assistant's tool-call turn, then execute each call.
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
                    {
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": output,
                    }
                )
        else:
            # Ran out of tool iterations without a plain answer.
            if not final["content"]:
                final["content"] = "(stopped after too many tool steps)"

        if persist:
            self._save(session_id, "assistant", final["content"], final["reasoning"])
        return final

    # --- scheduled tasks -------------------------------------------------------

    def _schedule_alarm(self):
        rows = self._query("SELECT MIN(next_run) AS next FROM tasks")
        nxt = rows[0]["next"] if rows else None
        if nxt is not None:
            self.ctx.storage.setAlarm(nxt)

    async def _run_due_tasks(self):
        now = _now_ms()
        due = self._query("SELECT * FROM tasks WHERE next_run <= ?", now)
        for task in due:
            await self._run(task["session_id"], task["prompt"])
            self._exec(
                "UPDATE tasks SET next_run = ? WHERE id = ?",
                now + task["every_minutes"] * 60_000,
                task["id"],
            )
        self._schedule_alarm()
        return len(due)

    async def alarm(self):
        await self._run_due_tasks()

    # --- HTTP routing (called via the Worker or sibling Durable Objects) -------

    async def on_fetch(self, request):
        from urllib.parse import urlparse, parse_qs

        url = urlparse(request.url)
        path = url.path
        query = parse_qs(url.query)
        method = request.method

        async def body():
            return (await request.json()).to_py()

        if path.endswith("/chat") and method == "POST":
            data = await body()
            session_id = data.get("session_id", "default")
            result = await self._run(session_id, data.get("message", ""))
            return _json_response(result)

        if path.endswith("/receive") and method == "POST":
            # Inter-agent message: answer without persisting to a user session.
            data = await body()
            result = await self._run("inbox", data.get("message", ""), persist=False)
            return _json_response({"reply": result["content"]})

        if path.endswith("/history") and method == "GET":
            session_id = (query.get("session_id") or ["default"])[0]
            rows = self._query(
                "SELECT role, content, reasoning, created_at FROM messages "
                "WHERE session_id = ? ORDER BY id ASC",
                session_id,
            )
            return _json_response({"messages": rows})

        if path.endswith("/sessions") and method == "GET":
            rows = self._query(
                "SELECT session_id, COUNT(*) AS count, MAX(created_at) AS last "
                "FROM messages GROUP BY session_id ORDER BY last DESC"
            )
            return _json_response({"sessions": rows})

        if path.endswith("/config"):
            if method == "POST":
                data = await body()
                if "name" in data:
                    self._set_meta("name", data["name"])
                if "instructions" in data:
                    self._set_meta("instructions", data["instructions"])
                return _json_response({"ok": True})
            return _json_response(
                {
                    "name": self._get_meta("name", "Ornith Agent"),
                    "instructions": self._get_meta(
                        "instructions", DEFAULT_SYSTEM_PROMPT
                    ),
                }
            )

        if path.endswith("/schedule") and method == "POST":
            data = await body()
            every = int(data.get("every_minutes", 60))
            self._exec(
                "INSERT INTO tasks (prompt, every_minutes, next_run, created_at) "
                "VALUES (?, ?, ?, ?)",
                data.get("prompt", ""),
                every,
                _now_ms() + every * 60_000,
                _now_ms(),
            )
            self._schedule_alarm()
            return _json_response({"ok": True})

        if path.endswith("/tasks") and method == "GET":
            return _json_response({"tasks": self._query("SELECT * FROM tasks ORDER BY id")})

        if path.endswith("/tick") and method == "POST":
            ran = await self._run_due_tasks()
            return _json_response({"ran": ran})

        return _json_response({"error": "not found", "path": path}, status=404)


def _to_js_init(method, body):
    """Build a JS fetch init object for a Durable Object sub-request."""
    init = {"method": method, "headers": {"content-type": "application/json"}}
    if body is not None:
        init["body"] = json.dumps(body)
    return ornith._to_js(init)
