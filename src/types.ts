/**
 * Shared type definitions for VoidClaw OS.
 */

export interface Env {
	/** Workers AI binding used to run inference for the agent loop. */
	AI: Ai;

	/** Static asset binding serving the OS desktop frontend. */
	ASSETS: { fetch: (request: Request) => Promise<Response> };

	/** Durable Object binding for the single-tenant VoidClaw kernel. */
	VOIDCLAW_CORE: DurableObjectNamespace;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
	ts?: number;
}

export type TaskType = "interval" | "cron";

export interface TaskRecord {
	id: string;
	type: TaskType;
	args: string;
	instruction: string;
	nextRun: number;
	createdAt: number;
}

export type FsNode = FsFile | FsDir;

export interface FsFile {
	type: "file";
	content: string;
	updatedAt: number;
}

export interface FsDir {
	type: "dir";
	children: Record<string, FsNode>;
}

export interface StatsState {
	startTime: number;
	totalTokens: number;
	toolUsage: Record<string, number>;
	activity: Record<string, number>;
}

export interface ConfigState {
	model: string;
	temperature: number;
}

export interface NotificationRecord {
	id: string;
	ts: number;
	message: string;
	taskId?: string;
}

export interface ToolCall {
	thought?: string;
	tool: string;
	args: Record<string, unknown>;
}

export interface StepEvent {
	type: "thought" | "action" | "observation" | "final" | "error";
	text: string;
	tool?: string;
}

export const AVAILABLE_MODELS = [
	"@cf/meta/llama-3.1-8b-instruct-fp8",
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/mistralai/mistral-small-3.1-24b-instruct",
	"@cf/google/gemma-3-12b-it",
] as const;

export const DEFAULT_MODEL: string = AVAILABLE_MODELS[0];
