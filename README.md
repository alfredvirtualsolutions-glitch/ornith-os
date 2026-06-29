# Ornith OS

A multi-agent **"operating system"** for AI agents, in **Python**, deployed on
**Vercel**, backed by **Neon Postgres**, with **Cloudflare** managing DNS — and
**Ornith-1.0** as the model brain.

Each agent has persistent memory, sessions, configuration, scheduled tasks, and
can spawn and delegate to other agents. State is stored in Neon and namespaced
per agent.

```text
                         Cloudflare DNS
                               │  (points your domain at Vercel)
                               ▼
Browser ── dashboard (public/) ──► Vercel
                                     │
                          ┌──────────┴───────────┐
                          │  api/index.py        │  FastAPI (Python)
                          │  /api/* routes        │
                          └─────┬──────────┬──────┘
                                ▼          ▼
                     ornith_os/agent   ornith_os/model ──► Ornith-1.0
                          │             (OpenAI /v1)        (vLLM / SGLang)
                          ▼
                  ornith_os/db ──► Neon Postgres (all state)
```

## Stack

| Concern | Choice |
| --- | --- |
| Frontend + API | Vercel (Python serverless functions, FastAPI) |
| Database | Neon Postgres (`DATABASE_URL`) |
| DNS | Cloudflare (point your domain at Vercel) |
| Model | Ornith-1.0 over its OpenAI-compatible `/v1` API |
| Scheduling | Vercel Cron → `POST /api/tick` |

## How the model works

**Ornith-1.0 is a GPU model (9B–397B params).** Vercel functions don't host it —
they call it. Serve Ornith yourself with vLLM/SGLang (see the Ornith model card),
expose the OpenAI-compatible `/v1` endpoint over HTTPS, and set `ORNITH_BASE_URL`
and `ORNITH_API_KEY`. With no endpoint configured, the app still runs and the API
works; chat replies with a "configure a model endpoint" notice.

## Features

- 💾 **Persistent state & sessions** — Neon Postgres, namespaced per agent.
- 💬 **Real-time chat** dashboard with reasoning and tool-step visibility.
- ⏰ **Scheduled tasks** — recurring prompts run by Vercel Cron hitting `/api/tick`.
- 🛠️ **Tool calling** — `get_time`, `calculate`, plus orchestration tools.
- 🤖 **Multi-agent orchestration** — `spawn_agent`, `send_to_agent`, `list_agents`.
- 📊 **Vercel Web Analytics** snippet in the dashboard.

## Project structure

```text
api/
  index.py        # FastAPI app: /api/* routes
ornith_os/
  agent.py        # agent logic: model loop, sessions, orchestration, tasks
  db.py           # Neon Postgres data layer (schema + queries)
  model.py        # Ornith client (OpenAI-compatible, via requests)
  tools.py        # tool registry + dispatch
public/
  index.html      # dashboard UI (+ Vercel Web Analytics)
  chat.js         # dashboard logic
vercel.json       # rewrites + includeFiles + cron
requirements.txt
.env.example
```

## Deploy

1. **Neon**: create a database and copy its pooled connection string.
2. **Vercel**: import this repo (Vercel auto-detects the Python function and
   serves `public/` statically). Set environment variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | your Neon pooled connection string |
   | `ORNITH_BASE_URL` | your Ornith `/v1` URL (optional) |
   | `ORNITH_API_KEY` | your Ornith key (optional) |

   Tables are created automatically on first request.
3. **Cloudflare DNS**: add your domain in Vercel, then in Cloudflare create the
   records Vercel shows (a `CNAME`/`A` to Vercel). Use **DNS-only** (grey cloud)
   for the verification records Vercel requires.

Local check:

```bash
pip install -r requirements.txt
# set DATABASE_URL (and optionally ORNITH_*), then:
uvicorn api.index:app --reload
```

## API

Per-agent routes accept `?agent_id=<id>` (default `main`).

| Method & path | Description |
| --- | --- |
| `GET /api/health` | Liveness + DB/model config check |
| `POST /api/chat` | `{session_id, message}` → `{content, reasoning, steps, source}` |
| `GET /api/history?session_id=` | Conversation history |
| `GET /api/sessions` | Sessions for the agent |
| `GET/POST /api/config` | Get / set the agent's name + instructions |
| `POST /api/schedule` | `{prompt, every_minutes}` → recurring task |
| `GET /api/tasks` | Scheduled tasks |
| `GET /api/agents` | List agents |
| `POST /api/agents` | `{name, instructions}` → spawn an agent |
| `POST /api/tick` | Run due scheduled tasks (called by Vercel Cron) |

## Notes

- Secrets (`DATABASE_URL`, `ORNITH_API_KEY`) live only in Vercel env vars — never
  in the repo.
- Vercel Cron cadence depends on your plan (Hobby is limited); adjust the
  schedule in `vercel.json`.

## License

MIT.
