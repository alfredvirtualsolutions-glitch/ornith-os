/**
 * Workspace — sandboxed virtual filesystem browser + text editor, backed
 * by the same tools VoidClaw itself uses (list_files, read_file, write_file...).
 */
export function mountFiles(root) {
	root.innerHTML = `
		<div class="app-root">
			<div class="fm-toolbar">
				<button class="btn" id="fm-up">⬆ Up</button>
				<span class="muted" id="fm-path">/</span>
				<button class="btn" id="fm-new-file">+ File</button>
				<button class="btn" id="fm-new-dir">+ Folder</button>
				<button class="btn" id="fm-refresh">Refresh</button>
			</div>
			<div class="fm-layout">
				<div class="fm-list" id="fm-list"></div>
				<div class="fm-editor">
					<div class="muted" id="fm-current">No file open</div>
					<textarea id="fm-content" placeholder="Select a file to edit..." disabled></textarea>
					<div class="fm-toolbar">
						<button class="btn" id="fm-save" disabled>Save</button>
						<button class="btn danger" id="fm-delete" disabled>Delete</button>
					</div>
				</div>
			</div>
		</div>
	`;

	let currentDir = "/";
	let currentFile = null;

	const list = root.querySelector("#fm-list");
	const pathLabel = root.querySelector("#fm-path");
	const content = root.querySelector("#fm-content");
	const currentLabel = root.querySelector("#fm-current");
	const saveBtn = root.querySelector("#fm-save");
	const deleteBtn = root.querySelector("#fm-delete");

	function joinPath(dir, name) {
		return dir === "/" ? `/${name}` : `${dir}/${name}`;
	}

	async function loadDir(path) {
		currentDir = path;
		currentFile = null;
		content.value = "";
		content.disabled = true;
		saveBtn.disabled = true;
		deleteBtn.disabled = true;
		currentLabel.textContent = "No file open";
		pathLabel.textContent = path;

		const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
		const data = await res.json();
		list.innerHTML = "";
		if (data.type !== "dir") return;
		if (data.entries.length === 0) {
			list.innerHTML = `<p class="muted">(empty)</p>`;
			return;
		}
		for (const entry of data.entries) {
			const isDir = entry.endsWith("/");
			const name = isDir ? entry.slice(0, -1) : entry;
			const row = document.createElement("div");
			row.className = "fm-entry";
			row.innerHTML = `<span>${isDir ? "📁" : "📄"} ${name}</span>`;
			row.addEventListener("click", () => {
				const full = joinPath(path, name);
				if (isDir) loadDir(full);
				else openFile(full);
			});
			list.appendChild(row);
		}
	}

	async function openFile(path) {
		const res = await fetch(`/api/files?path=${encodeURIComponent(path)}&mode=read`);
		const data = await res.json();
		currentFile = path;
		currentLabel.textContent = path;
		content.value = data.content ?? "";
		content.disabled = false;
		saveBtn.disabled = false;
		deleteBtn.disabled = false;
	}

	root.querySelector("#fm-up").addEventListener("click", () => {
		if (currentDir === "/") return;
		const parts = currentDir.split("/").filter(Boolean);
		parts.pop();
		loadDir(parts.length ? `/${parts.join("/")}` : "/");
	});
	root.querySelector("#fm-refresh").addEventListener("click", () => loadDir(currentDir));

	root.querySelector("#fm-new-file").addEventListener("click", async () => {
		const name = prompt("New file name:");
		if (!name) return;
		await fetch("/api/files", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: joinPath(currentDir, name), content: "" }),
		});
		loadDir(currentDir);
	});

	root.querySelector("#fm-new-dir").addEventListener("click", async () => {
		const name = prompt("New folder name:");
		if (!name) return;
		await fetch("/api/files/mkdir", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: joinPath(currentDir, name) }),
		});
		loadDir(currentDir);
	});

	saveBtn.addEventListener("click", async () => {
		if (!currentFile) return;
		await fetch("/api/files", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: currentFile, content: content.value }),
		});
	});

	deleteBtn.addEventListener("click", async () => {
		if (!currentFile || !confirm(`Delete ${currentFile}?`)) return;
		await fetch(`/api/files?path=${encodeURIComponent(currentFile)}`, { method: "DELETE" });
		loadDir(currentDir);
	});

	loadDir("/");
}
