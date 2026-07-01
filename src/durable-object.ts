/**
 * VoidClawCore — the single-tenant "kernel" behind VoidClaw OS.
 *
 * One Durable Object instance holds everything a personal, local-first
 * agent used to keep on disk: the evolving user profile, chat history, the
 * sandboxed workspace filesystem, scheduled autonomous tasks (driven by a
 * single DO alarm), tool-usage stats, and live config. It also terminates
 * a hibernatable WebSocket so the desktop UI gets real-time "proactive"
 * notifications when a background task fires — the cloud equivalent of the
 * original agent's 24/7 autonomy.
 */
import { DurableObject } from "cloudflare:workers";
import type {
	ChatMessage,
	ConfigState,
	Env,
	FsDir,
	NotificationRecord,
	StatsState,
	TaskRecord,
} from "./types";
import { DEFAULT_MODEL, AVAILABLE_MODELS } from "./types";
import {
	emptyRoot,
	countFiles,
	listDir,
	readFile as vfsReadFile,
	renderTree,
	writeFile,
	deleteEntry,
	createDirectory,
	moveEntry,
} from "./fs";
import { computeNextRun } from "./cron";
import { runReactLoop } from "./agent";
import type { KernelState } from "./tools";

const KEYS = {
	profile: "profile",
	history: "history",
	tasks: "tasks",
	fs: "fs",
	stats: "stats",
	config: "config",
} as const;

const DEFAULT_PROFILE = "# User Profile\n- Initialized. VoidClaw OS is learning your preferences.";
const MAX_HISTORY = 60;

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
	});
}

function sse(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

export class VoidClawCore extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") === "websocket") {
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);
			return new Response(null, { status: 101, webSocket: pair[0] });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path === "/api/chat" && request.method === "POST") return this.handleChat(request);
			if (path === "/api/dashboard" && request.method === "GET") return this.handleDashboard();
			if (path === "/api/memory" && request.method === "GET") return this.handleMemoryGet();
			if (path === "/api/memory" && request.method === "PUT") return this.handleMemoryPut(request);
			if (path === "/api/tasks" && request.method === "GET") return this.handleTasksList();
			if (path === "/api/tasks" && request.method === "POST") return this.handleTasksCreate(request);
			if (path === "/api/tasks" && request.method === "DELETE") return this.handleTasksDelete(request);
			if (path === "/api/files" && request.method === "GET") return this.handleFilesGet(url);
			if (path === "/api/files" && request.method === "PUT") return this.handleFilesPut(request);
			if (path === "/api/files" && request.method === "DELETE") return this.handleFilesDelete(url);
			if (path === "/api/files/mkdir" && request.method === "POST") return this.handleFilesMkdir(request);
			if (path === "/api/files/move" && request.method === "POST") return this.handleFilesMove(request);
			if (path === "/api/config" && request.method === "GET") return this.handleConfigGet();
			if (path === "/api/config" && request.method === "PUT") return this.handleConfigPut(request);
			if (path === "/api/session/reset" && request.method === "POST") return this.handleReset();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return json({ error: message }, { status: 400 });
		}

		return json({ error: "Not found" }, { status: 404 });
	}

	// ---------- storage helpers ----------

	private async loadState(): Promise<KernelState> {
		const [profile, tasks, fs, stats, config] = await Promise.all([
			this.ctx.storage.get<string>(KEYS.profile),
			this.ctx.storage.get<Record<string, TaskRecord>>(KEYS.tasks),
			this.ctx.storage.get<FsDir>(KEYS.fs),
			this.ctx.storage.get<StatsState>(KEYS.stats),
			this.ctx.storage.get<ConfigState>(KEYS.config),
		]);
		return {
			profile: profile ?? DEFAULT_PROFILE,
			tasks: tasks ?? {},
			fs: fs ?? emptyRoot(),
			stats: stats ?? { startTime: Date.now(), totalTokens: 0, toolUsage: {}, activity: {} },
			config: config ?? { model: DEFAULT_MODEL, temperature: 0.7 },
		};
	}

	private async saveState(state: KernelState): Promise<void> {
		await this.ctx.storage.put({
			[KEYS.profile]: state.profile,
			[KEYS.tasks]: state.tasks,
			[KEYS.fs]: state.fs,
			[KEYS.stats]: state.stats,
			[KEYS.config]: state.config,
		});
	}

	private async loadHistory(): Promise<ChatMessage[]> {
		return (await this.ctx.storage.get<ChatMessage[]>(KEYS.history)) ?? [];
	}

	private async saveHistory(history: ChatMessage[]): Promise<void> {
		await this.ctx.storage.put(KEYS.history, history.slice(-MAX_HISTORY));
	}

	private bumpActivity(stats: StatsState): void {
		const day = new Date().toISOString().slice(0, 10);
		stats.activity[day] = (stats.activity[day] ?? 0) + 1;
	}

	private async rescheduleAlarm(tasks: Record<string, TaskRecord>): Promise<void> {
		const soonest = Object.values(tasks).sort((a, b) => a.nextRun - b.nextRun)[0];
		if (soonest) {
			await this.ctx.storage.setAlarm(soonest.nextRun);
		} else {
			await this.ctx.storage.deleteAlarm();
		}
	}

	private broadcast(payload: unknown): void {
		const data = JSON.stringify(payload);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(data);
			} catch {
				// socket may be closing; ignore
			}
		}
	}

	// ---------- alarm: autonomous task execution ----------

	async alarm(): Promise<void> {
		const state = await this.loadState();
		const history = await this.loadHistory();
		const now = Date.now();
		const due = Object.values(state.tasks).filter((t) => t.nextRun <= now);

		for (const task of due) {
			try {
				const result = await runReactLoop(
					this.env,
					state,
					history,
					`AUTONOMOUS SCHEDULED TASK: ${task.instruction}`,
				);
				state.stats.totalTokens += result.tokensUsed;
				this.bumpActivity(state.stats);

				history.push({ role: "system", content: `⏰ Scheduled task fired: ${task.instruction}`, ts: now });
				history.push({ role: "assistant", content: result.final, ts: now });

				const notification: NotificationRecord = {
					id: crypto.randomUUID().slice(0, 8),
					ts: now,
					message: result.final,
					taskId: task.id,
				};
				this.broadcast({ type: "notification", ...notification });

				if (task.type === "interval") {
					task.nextRun = computeNextRun("interval", task.args, new Date(now));
				} else {
					task.nextRun = computeNextRun("cron", task.args, new Date(now));
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.broadcast({ type: "notification", id: crypto.randomUUID().slice(0, 8), ts: now, message: `Task "${task.instruction}" failed: ${message}` });
			}
		}

		await this.saveState(state);
		await this.saveHistory(history);
		await this.rescheduleAlarm(state.tasks);
	}

	async webSocketMessage(): Promise<void> {
		// The desktop UI only listens; it doesn't send anything meaningful yet.
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		if (!wasClean) return;
		ws.close(code, reason);
	}

	// ---------- HTTP handlers ----------

	private async handleChat(request: Request): Promise<Response> {
		const { message } = (await request.json()) as { message?: string };
		if (!message || typeof message !== "string") {
			return json({ error: "message is required" }, { status: 400 });
		}

		const state = await this.loadState();
		const history = await this.loadHistory();

		const encoder = new TextEncoder();
		const self = this;
		const stream = new ReadableStream({
			async start(controller) {
				const push = (payload: unknown) => controller.enqueue(encoder.encode(sse(payload)));
				try {
					history.push({ role: "user", content: message, ts: Date.now() });

					const result = await runReactLoop(self.env, state, history, message);
					for (const step of result.steps) push(step);

					history.push({ role: "assistant", content: result.final, ts: Date.now() });
					state.stats.totalTokens += result.tokensUsed;
					self.bumpActivity(state.stats);

					await self.saveHistory(history);
					await self.saveState(state);
					if (result.rescheduleAlarm) await self.rescheduleAlarm(state.tasks);

					push({ type: "done" });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					push({ type: "error", text: msg });
				} finally {
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	private async handleDashboard(): Promise<Response> {
		const state = await this.loadState();
		const history = await this.loadHistory();
		const ws = countFiles(state.fs);

		return json({
			uptime: Date.now() - state.stats.startTime,
			totalTokens: state.stats.totalTokens,
			toolUsage: state.stats.toolUsage,
			activity: state.stats.activity,
			tasks: Object.values(state.tasks).sort((a, b) => a.nextRun - b.nextRun),
			workspace: { files: ws.files, sizeKb: Math.round((ws.bytes / 1024) * 100) / 100 },
			config: state.config,
			availableModels: AVAILABLE_MODELS,
			messageCount: history.length,
			channels: ["Web OS"],
		});
	}

	private async handleMemoryGet(): Promise<Response> {
		const state = await this.loadState();
		return json({ profile: state.profile });
	}

	private async handleMemoryPut(request: Request): Promise<Response> {
		const { profile } = (await request.json()) as { profile?: string };
		if (typeof profile !== "string") return json({ error: "profile is required" }, { status: 400 });
		const state = await this.loadState();
		state.profile = profile;
		await this.saveState(state);
		return json({ ok: true });
	}

	private async handleTasksList(): Promise<Response> {
		const state = await this.loadState();
		return json({ tasks: Object.values(state.tasks).sort((a, b) => a.nextRun - b.nextRun) });
	}

	private async handleTasksCreate(request: Request): Promise<Response> {
		const body = (await request.json()) as { type?: "interval" | "cron"; args?: string; instruction?: string };
		if (!body.type || !body.args || !body.instruction) {
			return json({ error: "type, args and instruction are required" }, { status: 400 });
		}
		const state = await this.loadState();
		const id = crypto.randomUUID().slice(0, 8);
		const nextRun = computeNextRun(body.type, body.args, new Date());
		state.tasks[id] = { id, type: body.type, args: body.args, instruction: body.instruction, nextRun, createdAt: Date.now() };
		await this.saveState(state);
		await this.rescheduleAlarm(state.tasks);
		return json({ task: state.tasks[id] });
	}

	private async handleTasksDelete(request: Request): Promise<Response> {
		const { id } = (await request.json()) as { id?: string };
		if (!id) return json({ error: "id is required" }, { status: 400 });
		const state = await this.loadState();
		delete state.tasks[id];
		await this.saveState(state);
		await this.rescheduleAlarm(state.tasks);
		return json({ ok: true });
	}

	private async handleFilesGet(url: URL): Promise<Response> {
		const path = url.searchParams.get("path") ?? "/";
		const mode = url.searchParams.get("mode") ?? "auto";
		const state = await this.loadState();
		if (mode === "read") {
			return json({ type: "file", content: vfsReadFile(state.fs, path) });
		}
		try {
			const entries = listDir(state.fs, path);
			return json({ type: "dir", entries });
		} catch {
			return json({ type: "file", content: vfsReadFile(state.fs, path) });
		}
	}

	private async handleFilesPut(request: Request): Promise<Response> {
		const { path, content } = (await request.json()) as { path?: string; content?: string };
		if (!path) return json({ error: "path is required" }, { status: 400 });
		const state = await this.loadState();
		writeFile(state.fs, path, content ?? "");
		await this.saveState(state);
		return json({ ok: true });
	}

	private async handleFilesDelete(url: URL): Promise<Response> {
		const path = url.searchParams.get("path");
		if (!path) return json({ error: "path is required" }, { status: 400 });
		const state = await this.loadState();
		deleteEntry(state.fs, path);
		await this.saveState(state);
		return json({ ok: true });
	}

	private async handleFilesMkdir(request: Request): Promise<Response> {
		const { path } = (await request.json()) as { path?: string };
		if (!path) return json({ error: "path is required" }, { status: 400 });
		const state = await this.loadState();
		createDirectory(state.fs, path);
		await this.saveState(state);
		return json({ ok: true });
	}

	private async handleFilesMove(request: Request): Promise<Response> {
		const { from, to } = (await request.json()) as { from?: string; to?: string };
		if (!from || !to) return json({ error: "from and to are required" }, { status: 400 });
		const state = await this.loadState();
		moveEntry(state.fs, from, to);
		await this.saveState(state);
		return json({ ok: true });
	}

	private async handleConfigGet(): Promise<Response> {
		const state = await this.loadState();
		return json({ config: state.config, availableModels: AVAILABLE_MODELS });
	}

	private async handleConfigPut(request: Request): Promise<Response> {
		const body = (await request.json()) as Partial<ConfigState>;
		const state = await this.loadState();
		if (body.model) {
			if (!(AVAILABLE_MODELS as readonly string[]).includes(body.model)) {
				return json({ error: "Unknown model" }, { status: 400 });
			}
			state.config.model = body.model;
		}
		if (typeof body.temperature === "number") {
			state.config.temperature = Math.min(2, Math.max(0, body.temperature));
		}
		await this.saveState(state);
		return json({ config: state.config });
	}

	private async handleReset(): Promise<Response> {
		await this.saveHistory([]);
		return json({ ok: true });
	}
}
