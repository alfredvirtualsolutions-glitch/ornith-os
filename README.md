# Ornith OS

A durable, multi-agent **"operating system"** for AI agents — built in **Python**
on **Cloudflare Workers + Durable Objects**, with **Ornith-1.0** as the model
"brain."

All agent state lives in a single **D1 (SQLite) database**, namespaced per
agent: memory, sessions, configuration, the agent registry, and scheduled tasks.
This keeps the whole runtime on the Cloudflare **Workers Free plan** — no Durable
Objects required. The agent logic runs in-process in the Worker, and scheduled
work is driven by the cron trigger, which scans D1 for due tasks.

```
Browser ── dashboard (public/) ──┐
                                  ▼
        ┌──────────────────────────────────────┐
        │  Worker entry (src/entry.py)          │  HTTP + cron router
        └───────────────┬──────────────────────┘
                        ▼
        ┌──────────────────────────────────────┐
        │  agent_core.py                        │  in-process agent logic
        │  • model loop + tool calling          │
        │  • sessions / memory                  │
        │  • spawn / route / list agents        │
        │  • scheduled tasks (cron-driven)      │
        └───────┬───────────────────┬───────────┘
                ▼                   ▼
        ┌──────────────┐    ┌───────────────┐   OpenAI-compatible /v1
        │ store.py (D1)│    │ src/ornith.py │ ─▶ Ornith-1.0 (vLLM / SGLang)
        │ all state    │    │ model client  │ ─▶ Workers AI (fallback, no GPU)
        └──────────────┘    └───────────────┘
```

## How the model works (important)

**Ornith-1.0 is a GPU model (9B–397B params); Cloudflare does not host it.**
Cloudflare runs the *agent runtime* — the durable state, sessions, scheduling,
routing, and tools. The model itself runs wherever you serve it, exposing the
OpenAI-compatible `/v1` API that Ornith provides under vLLM or SGLang.

`src/ornith.py` calls that endpoint. If no endpoint is configured, it
**transparently falls back to Cloudflare Workers AI**, so the whole OS runs
end-to-end with zero GPU for local development and demos. Point it at a real
Ornith server when you're ready — nothing else changes.

### Serving Ornith-1.0 (the GPU side)

On any machine with the required GPUs (per the Ornith model card):

```bash
MODEL=deepreinforce-ai/Ornith-1.0-397B   # or -9B / -35B (+ -FP8 for lower VRAM)
vllm serve $MODEL \
    --served-model-name Ornith-1.0 \
    --tensor-parallel-size 8 \
    --host 0.0.0.0 --port 8000 \
    --max-model-len 262144 \
    --enable-auto-tool-choice --tool-call-parser qwen3_xml \
    --reasoning-parser qwen3 \
    --trust-remote-code
```

Then expose it over HTTPS (a tunnel, a reverse proxy, or
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)) and give
Ornith OS its URL.

## Features

- 🧠 **Ornith-1.0 brain** over the OpenAI-compatible API, with reasoning
  (`<think>` / `reasoning_content`) surfaced separately in the UI.
- 💾 **Persistent state & sessions** — D1-backed, namespaced per agent.
- 💬 **Real-time chat** dashboard with reasoning and tool-step visibility.
- ⏰ **Scheduled tasks** — recurring prompts run by the 5-minute cron tick.
- 🛠️ **Tool calling** — `get_time`, `calculate`, plus orchestration tools.
- 🤖 **Multi-agent orchestration** — agents can `spawn_agent`, `send_to_agent`,
  and `list_agents`.
- 📊 **Frontend analytics** — Vercel Web Analytics snippet in the dashboard.

## Project structure

```
src/
  entry.py       # Worker entrypoint: HTTP router + cron handler
  agent_core.py  # In-process agent logic: model loop, sessions, orchestration, tasks
  store.py       # D1 storage layer (schema + queries)
  ornith.py      # Model client: Ornith /v1 with Workers AI fallback
  tools.py       # Tool registry + dispatch
public/
  index.html     # Dashboard UI (+ Vercel Web Analytics snippet)
  chat.js        # Dashboard logic
wrangler.jsonc
.dev.vars.example
```

## Getting started

Prerequisites: Node.js (for the Wrangler CLI) and a Cloudflare account with
Workers AI enabled.

```bash
npm install

# Optional: point at a real Ornith endpoint (otherwise Workers AI is used).
cp .dev.vars.example .dev.vars   # then fill in ORNITH_BASE_URL / ORNITH_API_KEY

npm run dev                      # local dev at http://localhost:8787
```

### Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `ORNITH_BASE_URL` | `vars` / `.dev.vars` | Ornith `/v1` base URL. Empty ⇒ Workers AI fallback. |
| `ORNITH_API_KEY` | **secret** | API key for the Ornith endpoint. |
| `ORNITH_MODEL` | `vars` | Served model name (default `Ornith-1.0`). |
| `ORNITH_FALLBACK_MODEL` | `vars` | Workers AI model used when no endpoint set. |
| `ORNITH_TEMPERATURE` / `ORNITH_TOP_P` / `ORNITH_MAX_TOKENS` | `vars` | Sampling. |

### Deploy

The D1 database `ornith-os-db` is already referenced in `wrangler.jsonc`. If you
need to recreate it in your own account, run `wrangler d1 create ornith-os-db`
and paste the returned `database_id` into `wrangler.jsonc`.

```bash
wrangler secret put ORNITH_API_KEY    # if using a real Ornith endpoint
npm run deploy
```

Schema tables are created automatically on first request (and on the first cron
tick), so there's no separate migration step.

## API

All per-agent routes accept `?agent_id=<id>` (default `main`).

| Method & path | Description |
| --- | --- |
| `POST /api/chat` | `{session_id, message}` → run the agent, returns `{content, reasoning, steps, source}` |
| `GET /api/history?session_id=` | Conversation history |
| `GET /api/sessions` | Sessions for the agent |
| `GET/POST /api/config` | Get / set the agent's name + instructions |
| `POST /api/schedule` | `{prompt, every_minutes}` → recurring task |
| `GET /api/tasks` | Scheduled tasks |
| `GET /api/agents` | List all agents |
| `POST /api/agents` | `{name, instructions}` → spawn an agent |
| `POST /api/tick` | Manually run due scheduled tasks |

## Analytics

The dashboard includes the **Vercel Web Analytics** script. Because the frontend
is served by the Cloudflare Worker (not Vercel), the script loads from Vercel's
CDN; full reporting requires the domain to be registered as a Vercel project with
Web Analytics enabled. To switch to a native option, replace the snippet in
`public/index.html` with [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/).

## Notes & status

- Targets the **Cloudflare Python Workers** runtime (Pyodide) with **D1** for
  state — no Durable Objects, so it runs on the Workers Free plan. Python Workers
  are a newer Cloudflare surface; validate with `npm run check`
  (`wrangler deploy --dry-run`) and a `wrangler dev` smoke test.
- The model client uses raw `fetch` against the OpenAI-compatible endpoint (no
  `openai` Python SDK), which keeps it dependency-free inside Pyodide.
- The dashboard uses the JSON HTTP API; per-agent state is namespaced by
  `agent_id` in the shared D1 database.

## License

MIT.
