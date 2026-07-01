/**
 * VoidClaw OS — Worker entry point.
 *
 * Routes everything under /api/* and the WebSocket endpoint at /ws to the
 * single-tenant VoidClawCore Durable Object; everything else is the
 * desktop frontend served from static assets.
 */
import type { Env } from "./types";

export { VoidClawCore } from "./durable-object";

const CORE_ID = "voidclaw-main";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
			const id = env.VOIDCLAW_CORE.idFromName(CORE_ID);
			const stub = env.VOIDCLAW_CORE.get(id);
			return stub.fetch(request);
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
