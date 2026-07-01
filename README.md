# VoidClaw OS

A cloud-native, browser-based "desktop" for the VoidClaw autonomous agent — no install, no local Python
process, no phone. Open a URL and you get a windowed OS: a ReAct agent terminal, a persistent memory
vault, a 24/7 task scheduler, a sandboxed workspace filesystem, and a live system monitor, all running
on Cloudflare Workers, Workers AI and a single Durable Object.

This is a from-scratch reimplementation of the concepts in the original local-first
[VoidClaw-Agent](https://github.com/AbuZar-Ansarii/VoidClaw-Agent) (a Python CLI/Telegram/local-web agent)
for a serverless, single-tenant cloud environment. Hardware-specific features from that project — Android
control via Shizuku, YouTube downloading, media conversion, a Python code sandbox — don't have an honest
equivalent in a Worker (no disk, no shell, no device), so they were left out rather than faked. Everything
else (the ReAct reasoning loop, evolving user profile, sandboxed workspace, autonomous scheduler, tool
arsenal) has been rebuilt natively for this stack.

## Architecture

```
src/
├── index.ts           Worker entry point — routes /api/* and /ws to the Durable Object,
│                       everything else to the static desktop frontend
├── durable-object.ts   VoidClawCore — the single-tenant "kernel": HTTP routing, WebSocket
│                       hibernation for push notifications, and the alarm-driven scheduler
├── agent.ts            The ReAct loop: builds the system prompt, calls Workers AI, parses
│                       tool calls, and feeds observations back until there's a final answer
├── tools.ts            The tool arsenal (filesystem, memory, web search/scrape, weather,
│                       scheduling, config)
├── fs.ts               Sandboxed virtual filesystem (a JSON tree in Durable Object storage)
├── cron.ts             Minimal 5-field cron evaluator + interval parsing for the scheduler
└── types.ts            Shared types and the available Workers AI model list

public/
├── index.html          OS shell: boot sequence, desktop, taskbar, start menu
├── css/os.css          Glassmorphism / amber theme
└── js/
    ├── os.js           Window manager (drag/resize/focus/minimize/maximize), boot animation,
    │                   toast notifications, WebSocket client
    └── apps/           One module per app: terminal, memory, tasks, files, monitor, settings
```

There is one Durable Object instance for the whole deployment (`idFromName("voidclaw-main")`) — this is
a personal, single-user OS, the same way the original agent was local-first and single-user on one
machine. All state (profile, chat history, workspace files, scheduled tasks, config, stats) lives in that
one object's storage.

### The autonomous scheduler

Workers has no cron daemon you can register at runtime, so scheduling is built on a single Durable Object
**alarm**: every task tracks its own `nextRun`, the alarm is always set to the soonest one, and when it
fires the kernel runs the ReAct loop for that task's instruction, reschedules it, and broadcasts the
result over WebSocket so any open browser tab shows a toast notification (with a short tone) in real
time — the cloud equivalent of the original agent's 24/7 proactive messaging.

### Tool arsenal

`list_files`, `read_file`, `write_file`, `delete_file`, `create_directory`, `move_file` / `rename_file`,
`get_workspace_tree` (sandboxed virtual filesystem) · `update_user_profile` (writes to the memory vault)
· `update_config` (model/temperature) · `web_search` (DuckDuckGo instant-answer API, no key required) ·
`web_scrape` (fetch + strip a URL to text) · `fetch_weather` (Open-Meteo, no key required) ·
`schedule_task` / `remind_me` / `list_tasks` / `remove_task` / `stop_reminders` / `remove_all_tasks`.

## Local development

```bash
npm install
npm run dev          # wrangler dev; AI binding needs `--remote` or a deployed Worker to actually answer
npm run check         # tsc --noEmit + wrangler deploy --dry-run
```

## Deploy

```bash
npm run deploy
```

No environment variables or secrets are required — the Workers AI and Durable Object bindings are
declared in `wrangler.jsonc`.
