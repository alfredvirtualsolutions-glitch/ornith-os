/**
 * System Monitor — dashboard of uptime, token usage, tool usage and
 * scheduled task counts pulled from the Durable Object's stats.
 */
function formatUptime(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	return `${days}d ${hours}h ${minutes}m`;
}

export function mountMonitor(root) {
	root.innerHTML = `
		<div class="app-root">
			<div class="stat-grid" id="mon-stats"></div>
			<div>
				<div class="muted" style="margin-bottom:0.4rem;">Tool Usage</div>
				<div id="mon-tools"></div>
			</div>
		</div>
	`;

	const stats = root.querySelector("#mon-stats");
	const tools = root.querySelector("#mon-tools");

	async function load() {
		const res = await fetch("/api/dashboard");
		if (!res.ok) return;
		const data = await res.json();

		stats.innerHTML = `
			<div class="stat-card"><div class="stat-value">${formatUptime(data.uptime)}</div><div class="stat-label">Uptime</div></div>
			<div class="stat-card"><div class="stat-value">${data.totalTokens}</div><div class="stat-label">Tokens (est.)</div></div>
			<div class="stat-card"><div class="stat-value">${data.tasks.length}</div><div class="stat-label">Active Tasks</div></div>
			<div class="stat-card"><div class="stat-value">${data.workspace.files}</div><div class="stat-label">Workspace Files</div></div>
			<div class="stat-card"><div class="stat-value">${data.workspace.sizeKb} KB</div><div class="stat-label">Workspace Size</div></div>
			<div class="stat-card"><div class="stat-value">${data.messageCount}</div><div class="stat-label">Messages Logged</div></div>
		`;

		const entries = Object.entries(data.toolUsage).sort((a, b) => b[1] - a[1]);
		const max = entries.length ? entries[0][1] : 1;
		tools.innerHTML = entries.length
			? entries
					.map(
						([name, count]) => `
				<div class="bar-row">
					<span style="width:120px;">${name}</span>
					<div class="bar-track"><div class="bar-fill" style="width:${(count / max) * 100}%"></div></div>
					<span>${count}</span>
				</div>`,
					)
					.join("")
			: `<p class="muted">No tools used yet.</p>`;
	}

	load();
	const interval = setInterval(load, 10000);
	return () => clearInterval(interval);
}
