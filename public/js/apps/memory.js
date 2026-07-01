/**
 * Memory Vault — view and edit the persistent user profile VoidClaw
 * autonomously writes to via the update_user_profile tool.
 */
export function mountMemory(root) {
	root.innerHTML = `
		<div class="app-root">
			<p class="muted">Long-term memory VoidClaw uses across every session. It updates this automatically as it
			learns about you, and you can edit it directly here.</p>
			<textarea id="mem-text" style="flex:1;" placeholder="Loading..."></textarea>
			<div class="fm-toolbar">
				<button class="btn" id="mem-save">Save</button>
				<span class="muted" id="mem-status"></span>
			</div>
		</div>
	`;

	const textarea = root.querySelector("#mem-text");
	const status = root.querySelector("#mem-status");

	async function load() {
		const res = await fetch("/api/memory");
		const data = await res.json();
		textarea.value = data.profile ?? "";
	}

	async function save() {
		status.textContent = "Saving...";
		const res = await fetch("/api/memory", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ profile: textarea.value }),
		});
		status.textContent = res.ok ? "Saved." : "Failed to save.";
		setTimeout(() => (status.textContent = ""), 2000);
	}

	root.querySelector("#mem-save").addEventListener("click", save);
	load();
}
