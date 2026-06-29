"""D1-backed storage for Ornith OS.

All agent state lives in a single D1 (SQLite) database bound as ``env.DB`` and
namespaced by ``agent_id``. Using D1 instead of Durable Objects keeps the whole
runtime on the Cloudflare Workers Free plan.

Tables:
* ``agents``   — the agent registry (id, name, instructions).
* ``meta``     — per-agent key/value config (name, instructions).
* ``messages`` — per-agent, per-session conversation history.
* ``tasks``    — per-agent recurring scheduled tasks (run by the cron trigger).

The D1 client API is promise-based; every helper here is ``async``.
"""

_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS agents ("
    "agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, "
    "instructions TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS meta ("
    "agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
    "PRIMARY KEY (agent_id, key))",
    "CREATE TABLE IF NOT EXISTS messages ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, "
    "session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, "
    "reasoning TEXT DEFAULT '', created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS tasks ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, "
    "prompt TEXT NOT NULL, every_minutes INTEGER NOT NULL, "
    "next_run INTEGER NOT NULL, session_id TEXT NOT NULL DEFAULT 'scheduled', "
    "created_at INTEGER NOT NULL)",
]

# Schema is created lazily, once per isolate.
_ready = False


async def init(env):
    global _ready
    if _ready:
        return
    for stmt in _SCHEMA:
        await env.DB.prepare(stmt).run()
    _ready = True


async def query(env, sql, *params):
    """Run a SELECT and return a list of plain dict rows."""
    stmt = env.DB.prepare(sql)
    if params:
        stmt = stmt.bind(*params)
    result = await stmt.all()
    rows = result.results
    return rows.to_py() if rows is not None else []


async def first(env, sql, *params):
    """Run a SELECT and return the first row as a dict, or None."""
    stmt = env.DB.prepare(sql)
    if params:
        stmt = stmt.bind(*params)
    row = await stmt.first()
    return row.to_py() if row is not None else None


async def run(env, sql, *params):
    """Run an INSERT/UPDATE/DELETE statement."""
    stmt = env.DB.prepare(sql)
    if params:
        stmt = stmt.bind(*params)
    await stmt.run()
