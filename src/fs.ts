/**
 * Sandboxed virtual filesystem used by the "workspace" tools.
 * The whole tree lives as one JSON document in Durable Object storage —
 * fine at the scale of a personal workspace, and avoids ever touching a
 * real disk (Workers has none).
 */
import type { FsDir, FsFile, FsNode } from "./types";

export function emptyRoot(): FsDir {
	return { type: "dir", children: {} };
}

function splitPath(path: string): string[] {
	return path
		.split("/")
		.map((p) => p.trim())
		.filter((p) => p.length > 0 && p !== ".");
}

function requireDir(node: FsNode | undefined, label: string): FsDir {
	if (!node || node.type !== "dir") {
		throw new Error(`${label} is not a directory`);
	}
	return node;
}

/** Walks to the parent directory of `path`, optionally creating missing dirs. */
function walkToParent(
	root: FsDir,
	parts: string[],
	create: boolean,
): { parent: FsDir; name: string } {
	if (parts.length === 0) {
		throw new Error("Path must not be empty");
	}
	let dir = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const seg = parts[i];
		let next = dir.children[seg];
		if (!next) {
			if (!create) throw new Error(`Directory not found: ${parts.slice(0, i + 1).join("/")}`);
			next = { type: "dir", children: {} };
			dir.children[seg] = next;
		}
		dir = requireDir(next, seg);
	}
	return { parent: dir, name: parts[parts.length - 1] };
}

export function listDir(root: FsDir, path: string): string[] {
	const parts = splitPath(path);
	let dir = root;
	for (const seg of parts) {
		dir = requireDir(dir.children[seg], seg);
	}
	return Object.entries(dir.children)
		.map(([name, node]) => (node.type === "dir" ? `${name}/` : name))
		.sort();
}

export function readFile(root: FsDir, path: string): string {
	const parts = splitPath(path);
	if (parts.length === 0) throw new Error("Path must not be empty");
	const { parent, name } = walkToParent(root, parts, false);
	const node = parent.children[name];
	if (!node || node.type !== "file") throw new Error(`File not found: ${path}`);
	return node.content;
}

export function writeFile(root: FsDir, path: string, content: string): void {
	const parts = splitPath(path);
	if (parts.length === 0) throw new Error("Path must not be empty");
	const { parent, name } = walkToParent(root, parts, true);
	const existing = parent.children[name];
	if (existing && existing.type === "dir") {
		throw new Error(`${path} is a directory`);
	}
	const file: FsFile = { type: "file", content, updatedAt: Date.now() };
	parent.children[name] = file;
}

export function createDirectory(root: FsDir, path: string): void {
	const parts = splitPath(path);
	if (parts.length === 0) throw new Error("Path must not be empty");
	let dir = root;
	for (const seg of parts) {
		let next = dir.children[seg];
		if (!next) {
			next = { type: "dir", children: {} };
			dir.children[seg] = next;
		}
		dir = requireDir(next, seg);
	}
}

export function deleteEntry(root: FsDir, path: string): void {
	const parts = splitPath(path);
	if (parts.length === 0) throw new Error("Cannot delete the workspace root");
	const { parent, name } = walkToParent(root, parts, false);
	if (!(name in parent.children)) throw new Error(`Not found: ${path}`);
	delete parent.children[name];
}

export function moveEntry(root: FsDir, from: string, to: string): void {
	const fromParts = splitPath(from);
	const toParts = splitPath(to);
	if (fromParts.length === 0 || toParts.length === 0) {
		throw new Error("Path must not be empty");
	}
	const src = walkToParent(root, fromParts, false);
	const node = src.parent.children[src.name];
	if (!node) throw new Error(`Not found: ${from}`);
	const dst = walkToParent(root, toParts, true);
	if (dst.parent.children[dst.name]) {
		throw new Error(`Destination already exists: ${to}`);
	}
	delete src.parent.children[src.name];
	dst.parent.children[dst.name] = node;
}

export function renderTree(root: FsDir, prefix = ""): string {
	const lines: string[] = [];
	const entries = Object.entries(root.children).sort(([a], [b]) => a.localeCompare(b));
	entries.forEach(([name, node], idx) => {
		const isLast = idx === entries.length - 1;
		const branch = isLast ? "└── " : "├── ";
		lines.push(`${prefix}${branch}${node.type === "dir" ? `${name}/` : name}`);
		if (node.type === "dir") {
			const childPrefix = prefix + (isLast ? "    " : "│   ");
			lines.push(renderTree(node, childPrefix));
		}
	});
	return lines.filter((l) => l.length > 0).join("\n");
}

export function countFiles(root: FsDir): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	for (const node of Object.values(root.children)) {
		if (node.type === "file") {
			files += 1;
			bytes += node.content.length;
		} else {
			const sub = countFiles(node);
			files += sub.files;
			bytes += sub.bytes;
		}
	}
	return { files, bytes };
}
