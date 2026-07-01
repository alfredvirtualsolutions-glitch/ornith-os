/**
 * Task Scheduler — manage the autonomous background tasks that fire via
 * the Durable Object alarm (interval or cron triggers).
 */
export function mountTasks(root) {
	root.innerHTML = `
		<div class="app-root">
			<div id="task-list"></div>
			<div class="task-form">
				<select id="task-type">
					<option value="interval">Interval (e.g. 30s, 5m, 1h)</option>
					<option value="cron">Cron (min hour day month weekday)</option>
				</select>
				<input id="task-args" placeholder="e.g. 5m or 0 9 * * *" />
				<input id="task-instruction" class="full" placeholder="Instruction, e.g. Remind me to drink water" />
				<button class="btn full" id="task-add">Schedule Task</button>
			</div>
		</div>
	`;

	const list = root.querySelector("#task-list");

	async function load() {
		const res = await fetch("/api/tasks");
		const data = await res.json();
		list.innerHTML = "";
		if (!data.tasks || data.tasks.length === 0) {
			list.innerHTML = `<p class="muted">No autonomous tasks scheduled yet.</p>`;
			return;
		}
		for (const task of data.tasks) {
			const row = document.createElement("div");
			row.className = "task-row";
			const next = new Date(task.nextRun).toLocaleString();
			row.innerHTML = `
				<div>
					<div><strong>${task.type}:${task.args}</strong></div>
					<div class="muted">${task.instruction}</div>
					<div class="muted">Next: ${next}</div>
				</div>
				<button class="btn danger" data-id="${task.id}">Remove</button>
			`;
			row.querySelector("button").addEventListener("click", async () => {
				await fetch("/api/tasks", {
					method: "DELETE",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: task.id }),
				});
				load();
			});
			list.appendChild(row);
		}
	}

	root.querySelector("#task-add").addEventListener("click", async () => {
		const type = root.querySelector("#task-type").value;
		const args = root.querySelector("#task-args").value.trim();
		const instruction = root.querySelector("#task-instruction").value.trim();
		if (!args || !instruction) return;
		const res = await fetch("/api/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type, args, instruction }),
		});
		if (res.ok) {
			root.querySelector("#task-args").value = "";
			root.querySelector("#task-instruction").value = "";
			load();
		} else {
			const data = await res.json().catch(() => ({}));
			alert(data.error || "Failed to schedule task");
		}
	});

	load();
	const interval = setInterval(load, 15000);
	return () => clearInterval(interval);
}
