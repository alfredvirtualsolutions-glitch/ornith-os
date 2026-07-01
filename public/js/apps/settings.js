/**
 * Settings — model/temperature configuration and session controls.
 */
export function mountSettings(root) {
	root.innerHTML = `
		<div class="app-root">
			<label class="muted">Model</label>
			<select id="set-model"></select>

			<label class="muted">Temperature: <span id="set-temp-val"></span></label>
			<input id="set-temp" type="range" min="0" max="2" step="0.1" />

			<div class="fm-toolbar">
				<button class="btn" id="set-save">Save Settings</button>
				<button class="btn danger" id="set-reset">Reset Session</button>
			</div>
			<span class="muted" id="set-status"></span>
		</div>
	`;

	const modelSelect = root.querySelector("#set-model");
	const tempInput = root.querySelector("#set-temp");
	const tempVal = root.querySelector("#set-temp-val");
	const status = root.querySelector("#set-status");

	async function load() {
		const res = await fetch("/api/config");
		const data = await res.json();
		modelSelect.innerHTML = data.availableModels
			.map((m) => `<option value="${m}" ${m === data.config.model ? "selected" : ""}>${m}</option>`)
			.join("");
		tempInput.value = data.config.temperature;
		tempVal.textContent = data.config.temperature;
	}

	tempInput.addEventListener("input", () => (tempVal.textContent = tempInput.value));

	root.querySelector("#set-save").addEventListener("click", async () => {
		status.textContent = "Saving...";
		const res = await fetch("/api/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: modelSelect.value, temperature: parseFloat(tempInput.value) }),
		});
		status.textContent = res.ok ? "Saved." : "Failed.";
		setTimeout(() => (status.textContent = ""), 2000);
	});

	root.querySelector("#set-reset").addEventListener("click", async () => {
		if (!confirm("Clear the current chat session? Memory and tasks are kept.")) return;
		await fetch("/api/session/reset", { method: "POST" });
		status.textContent = "Session cleared.";
		setTimeout(() => (status.textContent = ""), 2000);
	});

	load();
}
