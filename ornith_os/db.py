"""Neon Postgres data layer for Ornith OS.

All agent state lives in a single Neon (Postgres) database, namespaced by
``agent_id``. Connections are opened per request (the natural model for Vercel
serverless functions) against the pooled Neon endpoint in ``DATABASE_URL``.

Tables:
* ``agents``   — the agent registry.
* ``meta``     — per-agent key/value config (name, instructions).
* ``messages`` — per-agent, per-session conversation history.
* ``tasks``    — per-agent recurring scheduled tasks (run by the cron endpoint).
"""

import contextlib
import os

import psycopg2
import psycopg2.extras

_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS agents ("
    "agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, "
    "instructions TEXT NOT NULL, created_at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS meta ("
    "agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
    "PRIMARY KEY (agent_id, key))",
    "CREATE TABLE IF NOT EXISTS messages ("
    "id BIGSERIAL PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, "
    "role TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT DEFAULT '', "
    "created_at BIGINT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS messages_agent_session_id_desc_idx "
    "ON messages (agent_id, session_id, id DESC)",
    "CREATE TABLE IF NOT EXISTS tasks ("
    "id BIGSERIAL PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL, "
    "every_minutes INTEGER NOT NULL, next_run BIGINT NOT NULL, "
    "session_id TEXT NOT NULL DEFAULT 'scheduled', created_at BIGINT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS tasks_next_run_idx ON tasks (next_run)",
    "CREATE INDEX IF NOT EXISTS tasks_agent_id_id_idx ON tasks (agent_id, id)",
]

_schema_ready = False


def _dsn():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not set (Neon connection string).")
    return dsn


@contextlib.contextmanager
def connect():
    """Yield a Postgres connection (committed on success, rolled back on error)."""
    conn = psycopg2.connect(_dsn(), cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init():
    """Create the schema once per warm function instance."""
    global _schema_ready
    if _schema_ready:
        return
    with connect() as conn:
        with conn.cursor() as cur:
            for stmt in _SCHEMA:
                cur.execute(stmt)
    _schema_ready = True


def query(sql, params=()):
    """Run a SELECT and return a list of dict rows."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]


def first(sql, params=()):
    """Run a SELECT and return the first row as a dict, or None."""
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql, params=()):
    """Run an INSERT/UPDATE/DELETE statement."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
