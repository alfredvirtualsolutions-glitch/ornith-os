/**
 * The VoidClaw OS tool arsenal.
 *
 * Every tool here is genuinely implementable inside a stateless Worker +
 * Durable Object: there is no real disk, no shell, and no device to
 * control, so filesystem tools operate on a sandboxed virtual tree, and
 * network tools use key-free public APIs. Tools that only made sense on a
 * physical device in the original local agent (Android/Shizuku control,
 * ffmpeg media conversion, yt-dlp downloads, a Python sandbox) are
 * intentionally left out rather than faked.
 */
import type { ConfigState, FsDir, StatsState, TaskRecord } from "./types";
import { AVAILABLE_MODELS } from "./types";
import * as vfs from "./fs";
import { computeNextRun, parseCron, parseIntervalMs } from "./cron";

export interface KernelState {
	profile: string;
	fs: FsDir;
	tasks: Record<string, TaskRecord>;
	config: ConfigState;
	stats: StatsState;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
	const v = args[key];
	if (typeof v === "string" && v.length > 0) return v;
	if (!required) return "";
	throw new Error(`Missing required argument: ${key}`);
}

function randomId(): string {
	return crypto.randomUUID().slice(0, 8);
}

async function webSearch(query: string): Promise<string> {
	const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
		query,
	)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
	const res = await fetch(url, { headers: { "User-Agent": "VoidClawOS/1.0" } });
	if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
	const data = (await res.json()) as {
		AbstractText?: string;
		Answer?: string;
		RelatedTopics?: Array<{ Text?: string; Topics?: Array<{ Text?: string }> }>;
	};
	const parts: string[] = [];
	if (data.AbstractText) parts.push(data.AbstractText);
	if (data.Answer) parts.push(`Answer: ${data.Answer}`);
	for (const topic of data.RelatedTopics?.slice(0, 5) ?? []) {
		if (topic.Text) parts.push(`- ${topic.Text}`);
		else for (const sub of topic.Topics?.slice(0, 3) ?? []) if (sub.Text) parts.push(`- ${sub.Text}`);
	}
	if (parts.length === 0) {
		return `No instant answer found for "${query}". Try web_scrape on a specific URL instead.`;
	}
	return parts.join("\n").slice(0, 2000);
}

async function webScrape(url: string): Promise<string> {
	const res = await fetch(url, { headers: { "User-Agent": "VoidClawOS/1.0" } });
	if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
	const html = await res.text();
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
	return text.slice(0, 3000);
}

async function fetchWeather(city: string): Promise<string> {
	const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
	const geoRes = await fetch(geoUrl);
	if (!geoRes.ok) throw new Error(`Geocoding failed: HTTP ${geoRes.status}`);
	const geo = (await geoRes.json()) as {
		results?: Array<{ latitude: number; longitude: number; name: string; country: string }>;
	};
	const first = geo.results?.[0];
	if (!first) throw new Error(`City not found: ${city}`);
	const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${first.latitude}&longitude=${first.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`;
	const wRes = await fetch(wUrl);
	if (!wRes.ok) throw new Error(`Forecast failed: HTTP ${wRes.status}`);
	const w = (await wRes.json()) as {
		current: { temperature_2m: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number };
	};
	const c = w.current;
	return `Weather in ${first.name}, ${first.country}: ${c.temperature_2m}°C, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h (code ${c.weather_code}).`;
}

function formatTasks(tasks: Record<string, TaskRecord>): string {
	const list = Object.values(tasks);
	if (list.length === 0) return "No autonomous tasks scheduled.";
	return list
		.sort((a, b) => a.nextRun - b.nextRun)
		.map(
			(t) =>
				`[${t.id}] ${t.type}:${t.args} -> "${t.instruction}" (next run: ${new Date(t.nextRun).toISOString()})`,
		)
		.join("\n");
}

export interface ToolResult {
	observation: string;
	/** True when the DO should recompute and reset its alarm after this call. */
	rescheduleAlarm: boolean;
}

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	state: KernelState,
): Promise<ToolResult> {
	let rescheduleAlarm = false;
	const observation = await (async (): Promise<string> => {
		switch (name) {
			case "list_files": {
				const path = str(args, "path", false) || "/";
				const entries = vfs.listDir(state.fs, path);
				return entries.length > 0 ? entries.join("\n") : "(empty directory)";
			}
			case "get_workspace_tree": {
				const tree = vfs.renderTree(state.fs);
				return tree.length > 0 ? tree : "(workspace is empty)";
			}
			case "read_file":
				return vfs.readFile(state.fs, str(args, "path"));
			case "write_file": {
				const path = str(args, "path");
				vfs.writeFile(state.fs, path, str(args, "content", false));
				return `Success: wrote ${path}`;
			}
			case "delete_file": {
				const path = str(args, "path");
				vfs.deleteEntry(state.fs, path);
				return `Success: deleted ${path}`;
			}
			case "create_directory": {
				const path = str(args, "path");
				vfs.createDirectory(state.fs, path);
				return `Success: created directory ${path}`;
			}
			case "move_file":
			case "rename_file": {
				const from = str(args, name === "rename_file" ? "path" : "from");
				const to = name === "rename_file" ? str(args, "new_name") : str(args, "to");
				vfs.moveEntry(state.fs, from, to);
				return `Success: moved ${from} -> ${to}`;
			}
			case "update_user_profile": {
				const info = str(args, "info");
				const stamp = new Date().toISOString().slice(0, 10);
				state.profile = `${state.profile.trimEnd()}\n- [${stamp}] ${info}`;
				return "Success: profile updated.";
			}
			case "update_config": {
				const key = str(args, "key");
				const value = str(args, "value");
				if (key === "model") {
					if (!(AVAILABLE_MODELS as readonly string[]).includes(value)) {
						throw new Error(`Unknown model: ${value}. Available: ${AVAILABLE_MODELS.join(", ")}`);
					}
					state.config.model = value;
				} else if (key === "temperature") {
					const t = parseFloat(value);
					if (Number.isNaN(t) || t < 0 || t > 2) throw new Error("Temperature must be between 0 and 2");
					state.config.temperature = t;
				} else {
					throw new Error(`Unsupported config key: ${key}`);
				}
				return `Success: ${key} set to ${value}`;
			}
			case "web_search":
				return await webSearch(str(args, "query"));
			case "web_scrape":
				return await webScrape(str(args, "url"));
			case "fetch_weather":
				return await fetchWeather(str(args, "city"));
			case "schedule_task":
			case "remind_me": {
				const isRemind = name === "remind_me";
				const type = isRemind ? "interval" : str(args, "trigger_type");
				const rawArgs = isRemind ? str(args, "time_args") : str(args, "schedule_args");
				const instruction = isRemind ? `Remind the user: ${str(args, "message")}` : str(args, "instruction");
				if (type !== "interval" && type !== "cron") {
					throw new Error(`Unsupported trigger type: ${type}`);
				}
				if (type === "cron") parseCron(rawArgs);
				else parseIntervalMs(rawArgs);
				const id = randomId();
				const nextRun = computeNextRun(type, rawArgs, new Date());
				state.tasks[id] = { id, type, args: rawArgs, instruction, nextRun, createdAt: Date.now() };
				rescheduleAlarm = true;
				return `Success: task ${id} scheduled (${type}: ${rawArgs})`;
			}
			case "list_tasks":
				return formatTasks(state.tasks);
			case "remove_task":
			case "stop_reminders": {
				const keyword = str(args, "keyword");
				if (state.tasks[keyword]) {
					delete state.tasks[keyword];
					rescheduleAlarm = true;
					return `Success: task ${keyword} removed.`;
				}
				const lower = keyword.toLowerCase();
				const matches = Object.values(state.tasks).filter((t) => t.instruction.toLowerCase().includes(lower));
				for (const m of matches) delete state.tasks[m.id];
				if (matches.length > 0) rescheduleAlarm = true;
				return matches.length > 0
					? `Success: removed ${matches.length} task(s) matching "${keyword}".`
					: `Error: no task found matching "${keyword}".`;
			}
			case "remove_all_tasks": {
				const count = Object.keys(state.tasks).length;
				state.tasks = {};
				rescheduleAlarm = true;
				return `Success: removed ${count} task(s).`;
			}
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	})().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		return `Error: ${message}`;
	});

	state.stats.toolUsage[name] = (state.stats.toolUsage[name] ?? 0) + 1;
	return { observation, rescheduleAlarm };
}
