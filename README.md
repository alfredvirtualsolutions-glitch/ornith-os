# Ornith OS

A durable, multi-agent **"operating system"** for AI agents — built in **Python**
on **Cloudflare Workers + Durable Objects**, with **Ornith-1.0** as the model
"brain."

Each agent is a Durable Object with its own SQLite database, so its memory,
sessions, configuration, and scheduled tasks are persistent and live at the
edge. A single **Kernel** Durable Object acts as the process table / scheduler:
it spawns agents, routes messages between them, and fans out the cron tick.

```
Browser ── dashboard (public/) ──┐
                                  ▼
        ┌──────────────────────────────────────┐
        │  Worker entry (src/entry.py)          │  HTTP + cron router
        └───────────────┬───────────────────────┘
            per-agent    │            fleet
                 ▼       │             ▼
        ┌───────────────┐│   ┌──────────────────┐
        │  Agent DO     ││   │  Kernel DO        │
        │  (src/agent)  ││   │  (src/kernel)     │
        │  • SQL memory ││   │  • agent registry │
        │  • sessions   ││   │  • message routing│
        │  • tool loop  ││   │  • cron fan-out   │
        │  • alarms     ││   └──────────────────┘
        └──────┬────────┘
               ▼
        ┌───────────────┐     OpenAI-compatible /v1
        │ src/ornith.py │ ──▶  Ornith-1.0 (vLLM / SGLang)
        │ model client  │ ──▶  Workers AI (fallback, no GPU)
        └───────────────┘
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
- 💾 **Persistent state & sessions** — each agent has its own SQLite DB in a
  Durable Object.
- 💬 **Real-time chat** dashboard with reasoning and tool-step visibility.
- ⏰ **Scheduled tasks** via Durable Object alarms + a 5-minute cron tick.
- 🛠️ **Tool calling** — `get_time`, `calculate`, plus orchestration tools.
- 🤖 **Multi-agent orchestration** — agents can `spawn_agent`, `send_to_agent`,
  and `list_agents` through the Kernel.

## Project structure

```
src/
  entry.py    # Worker entrypoint: HTTP router + cron handler; exports DO classes
  agent.py    # Agent Durable Object: memory, sessions, model loop, alarms
  kernel.py   # Kernel Durable Object: registry, routing, cron fan-out
  ornith.py   # Model client: Ornith /v1 with Workers AI fallback
  tools.py    # Tool registry + dispatch
public/
  index.html  # Dashboard UI
  chat.js     # Dashboard logic
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

```bash
wrangler secret put ORNITH_API_KEY    # if using a real Ornith endpoint
npm run deploy
```

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
| `GET /api/agents` | List agents (Kernel) |
| `POST /api/agents` | `{name, instructions}` → spawn an agent (Kernel) |
| `POST /api/tick` | Manually run due tasks across the fleet |

## Notes & status

- Targets the **Cloudflare Python Workers** runtime (Pyodide) with
  **SQLite-backed Durable Objects**. Python Workers and Python DOs are a newer
  Cloudflare surface; validate against your Wrangler version with
  `npm run check` and a `wrangler dev` smoke test before relying on it.
- The model client uses raw `fetch` against the OpenAI-compatible endpoint (no
  `openai` Python SDK), which keeps it dependency-free inside Pyodide.
- The dashboard uses the JSON HTTP API. A WebSocket transport can be layered on
  the Agent DO later for token-level streaming.

## License

MIT.
