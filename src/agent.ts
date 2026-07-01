/**
 * The ReAct reasoning loop: ask the model for a thought, let it either call
 * a tool or answer, execute tools against the kernel state, and feed the
 * observation back until it produces a final answer (mirrors the original
 * VoidClaw local agent's loop, adapted to a Workers AI chat-completion call
 * per step instead of a raw text completion).
 */
import type { ChatMessage, Env, StepEvent, ToolCall } from "./types";
import { executeTool, type KernelState } from "./tools";
import { renderTree } from "./fs";

const MAX_STEPS = 5;
const HISTORY_WINDOW = 10;

const TOOL_DOCS = `Tools:
- list_files, get_workspace_tree, read_file, write_file, delete_file, create_directory, move_file, rename_file (sandboxed virtual workspace)
- update_user_profile: info (save a durable fact about the user)
- update_config: key ("model" or "temperature"), value
- web_search: query (DuckDuckGo instant-answer lookup, best for facts/definitions)
- web_scrape: url (fetch a page and return its text content)
- fetch_weather: city
- schedule_task: trigger_type ("cron" or "interval"), schedule_args (5-field cron string, or "30s"/"5m"/"1h"), instruction
- remind_me: message, time_args (shortcut for a one-line reminder)
- list_tasks, remove_task (keyword or id), stop_reminders (keyword), remove_all_tasks`;

export function buildSystemPrompt(profile: string, workspaceTree: string): string {
	const now = new Date().toUTCString();
	return `# User Profile
${profile}

You are VoidClaw, an evolutionary autonomous agent running as a cloud-native OS on Cloudflare Workers.
IMPORTANT: You operate in a single continuous session for this user; the profile above is your only long-term memory across sessions.

System Time (UTC): ${now}

Current workspace:
${workspaceTree || "(empty)"}

Your primary directive is to grow and adapt to the user over time. Whenever you deduce new information about the
user's workflow, expertise level, personality, or preferences, you MUST autonomously call the 'update_user_profile'
tool to record it. Adapt your tone, verbosity, and technical depth based on the profile.

${TOOL_DOCS}

Respond ONLY with a single JSON object if you need a tool, and nothing else:
{"thought": "reasoning", "tool": "tool_name", "args": {}}

When a scheduled task fires you will receive a message prefixed "AUTONOMOUS SCHEDULED TASK:" — execute it and give a
clear final answer (for a reminder, simply state the reminder message).

Otherwise respond normally in plain text as your final answer to the user.`;
}

function parseToolCall(response: string): ToolCall | null {
	const tryParse = (text: string): ToolCall | null => {
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object" && "tool" in parsed) {
				return parsed as ToolCall;
			}
		} catch {
			// fall through
		}
		return null;
	};

	const direct = tryParse(response.trim());
	if (direct) return direct;

	const fenced = response.match(/```json\s*([\s\S]*?)```/i) ?? response.match(/```\s*([\s\S]*?)```/);
	if (fenced) return tryParse(fenced[1].trim());

	return null;
}

async function callModel(env: Env, model: string, temperature: number, messages: ChatMessage[]): Promise<string> {
	const result = (await env.AI.run(
		model as Parameters<Ai["run"]>[0],
		{
			messages: messages.map(({ role, content }) => ({ role, content })),
			max_tokens: 800,
			temperature,
		} as AiTextGenerationInput,
	)) as { response?: string };
	return result.response ?? "";
}

export interface ReactLoopResult {
	steps: StepEvent[];
	final: string;
	tokensUsed: number;
}

export async function runReactLoop(
	env: Env,
	state: KernelState,
	history: ChatMessage[],
	userText: string,
): Promise<ReactLoopResult & { rescheduleAlarm: boolean }> {
	const systemPrompt = buildSystemPrompt(state.profile, renderTree(state.fs));
	const messages: ChatMessage[] = [...history.slice(-HISTORY_WINDOW), { role: "user", content: userText }];
	const steps: StepEvent[] = [];
	let tokensUsed = Math.ceil(userText.length / 4);
	let rescheduleAlarm = false;

	for (let i = 0; i < MAX_STEPS; i++) {
		const response = await callModel(env, state.config.model, state.config.temperature, [
			{ role: "system", content: systemPrompt },
			...messages,
		]);
		tokensUsed += Math.ceil(response.length / 4);
		const toolCall = parseToolCall(response);

		if (toolCall && typeof toolCall.tool === "string") {
			const thought = toolCall.thought ?? "Processing...";
			steps.push({ type: "thought", text: thought });
			steps.push({ type: "action", text: toolCall.tool, tool: toolCall.tool });

			const { observation, rescheduleAlarm: needsReset } = await executeTool(
				toolCall.tool,
				toolCall.args ?? {},
				state,
			);
			if (needsReset) rescheduleAlarm = true;

			steps.push({ type: "observation", text: observation, tool: toolCall.tool });

			messages.push({ role: "assistant", content: response });
			messages.push({
				role: "user",
				content: `Observation from ${toolCall.tool}: ${observation}\n\nContinue toward a final answer.`,
			});
			continue;
		}

		steps.push({ type: "final", text: response });
		return { steps, final: response, tokensUsed, rescheduleAlarm };
	}

	const fallback = "Reasoning limit reached.";
	steps.push({ type: "final", text: fallback });
	return { steps, final: fallback, tokensUsed, rescheduleAlarm };
}
