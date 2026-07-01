/**
 * VoidClaw OS — window manager, boot sequence and shell chrome.
 * Apps register themselves via registerApp() and are opened as draggable,
 * resizable windows on the desktop.
 */

import { mountTerminal } from "./apps/terminal.js";
import { mountMemory } from "./apps/memory.js";
import { mountTasks } from "./apps/tasks.js";
import { mountFiles } from "./apps/files.js";
import { mountMonitor } from "./apps/monitor.js";
import { mountSettings } from "./apps/settings.js";

const APPS = [
	{ id: "terminal", title: "VoidClaw Terminal", icon: "𒆙", w: 620, h: 440, mount: mountTerminal },
	{ id: "monitor", title: "System Monitor", icon: "📊", w: 480, h: 420, mount: mountMonitor },
	{ id: "memory", title: "Memory Vault", icon: "🧠", w: 480, h: 420, mount: mountMemory },
	{ id: "tasks", title: "Task Scheduler", icon: "⏰", w: 520, h: 420, mount: mountTasks },
	{ id: "files", title: "Workspace", icon: "🗂️", w: 620, h: 420, mount: mountFiles },
	{ id: "settings", title: "Settings", icon: "⚙️", w: 420, h: 340, mount: mountSettings },
];

const windowsLayer = document.getElementById("windows-layer");
const taskbarApps = document.getElementById("taskbar-apps");
const desktopIcons = document.getElementById("desktop-icons");
const startMenu = document.getElementById("start-menu");
const startButton = document.getElementById("start-button");
const toastLayer = document.getElementById("toast-layer");
const connDot = document.getElementById("conn-status");

const openWindows = new Map(); // id -> { el, cleanup }
let zTop = 10;
let cascade = 0;

export function openApp(id) {
	const existing = openWindows.get(id);
	if (existing) {
		existing.el.classList.remove("minimized");
		focusWindow(id);
		return;
	}

	const app = APPS.find((a) => a.id === id);
	if (!app) return;

	const el = document.createElement("div");
	el.className = "os-window";
	el.style.width = `${app.w}px`;
	el.style.height = `${app.h}px`;
	el.style.left = `${80 + (cascade % 6) * 30}px`;
	el.style.top = `${60 + (cascade % 6) * 26}px`;
	cascade += 1;
	el.style.zIndex = String(++zTop);

	el.innerHTML = `
		<div class="window-titlebar">
			<span class="title-icon">${app.icon}</span>
			<span class="title-text">${app.title}</span>
			<div class="window-controls">
				<button class="btn-min" title="Minimize"></button>
				<button class="btn-max" title="Maximize"></button>
				<button class="btn-close" title="Close"></button>
			</div>
		</div>
		<div class="window-content"></div>
		<div class="resize-handle"></div>
	`;
	windowsLayer.appendChild(el);

	el.addEventListener("mousedown", () => focusWindow(id));
	el.querySelector(".btn-close").addEventListener("click", () => closeWindow(id));
	el.querySelector(".btn-min").addEventListener("click", () => {
		el.classList.add("minimized");
		syncTaskbar();
	});
	el.querySelector(".btn-max").addEventListener("click", () => {
		el.classList.toggle("maximized");
	});

	makeDraggable(el, el.querySelector(".window-titlebar"));
	makeResizable(el, el.querySelector(".resize-handle"));

	const content = el.querySelector(".window-content");
	const cleanup = app.mount(content) || (() => {});

	openWindows.set(id, { el, cleanup });
	focusWindow(id);
	syncTaskbar();
}

function closeWindow(id) {
	const win = openWindows.get(id);
	if (!win) return;
	win.cleanup();
	win.el.remove();
	openWindows.delete(id);
	syncTaskbar();
}

function focusWindow(id) {
	const win = openWindows.get(id);
	if (!win) return;
	win.el.style.zIndex = String(++zTop);
	for (const [otherId, other] of openWindows) {
		other.el.classList.toggle("focused", otherId === id);
	}
	syncTaskbar();
}

function syncTaskbar() {
	taskbarApps.innerHTML = "";
	for (const [id, win] of openWindows) {
		const app = APPS.find((a) => a.id === id);
		const btn = document.createElement("button");
		btn.className = "taskbar-app" + (win.el.classList.contains("focused") ? " active" : "");
		btn.textContent = `${app.icon} ${app.title}`;
		btn.addEventListener("click", () => {
			win.el.classList.remove("minimized");
			focusWindow(id);
		});
		taskbarApps.appendChild(btn);
	}
}

function makeDraggable(win, handle) {
	let dragging = false;
	let offX = 0;
	let offY = 0;
	handle.addEventListener("mousedown", (e) => {
		if (win.classList.contains("maximized")) return;
		dragging = true;
		offX = e.clientX - win.offsetLeft;
		offY = e.clientY - win.offsetTop;
		e.preventDefault();
	});
	window.addEventListener("mousemove", (e) => {
		if (!dragging) return;
		win.style.left = `${Math.max(0, e.clientX - offX)}px`;
		win.style.top = `${Math.max(0, e.clientY - offY)}px`;
	});
	window.addEventListener("mouseup", () => {
		dragging = false;
	});
}

function makeResizable(win, handle) {
	let resizing = false;
	let startW = 0;
	let startH = 0;
	let startX = 0;
	let startY = 0;
	handle.addEventListener("mousedown", (e) => {
		if (win.classList.contains("maximized")) return;
		resizing = true;
		startW = win.offsetWidth;
		startH = win.offsetHeight;
		startX = e.clientX;
		startY = e.clientY;
		e.preventDefault();
		e.stopPropagation();
	});
	window.addEventListener("mousemove", (e) => {
		if (!resizing) return;
		win.style.width = `${Math.max(320, startW + (e.clientX - startX))}px`;
		win.style.height = `${Math.max(220, startH + (e.clientY - startY))}px`;
	});
	window.addEventListener("mouseup", () => {
		resizing = false;
	});
}

// ---------- Desktop icons + start menu ----------

for (const app of APPS) {
	const btn = document.createElement("button");
	btn.className = "desktop-icon";
	btn.innerHTML = `<span class="icon-glyph">${app.icon}</span><span class="icon-label">${app.title}</span>`;
	btn.addEventListener("dblclick", () => openApp(app.id));
	btn.addEventListener("click", (e) => {
		if (e.detail === 2) openApp(app.id);
	});
	desktopIcons.appendChild(btn);

	const menuBtn = document.createElement("button");
	menuBtn.innerHTML = `<span>${app.icon}</span><span>${app.title}</span>`;
	menuBtn.addEventListener("click", () => {
		openApp(app.id);
		startMenu.hidden = true;
	});
	startMenu.appendChild(menuBtn);
}

startButton.addEventListener("click", () => {
	startMenu.hidden = !startMenu.hidden;
});
document.addEventListener("click", (e) => {
	if (!startMenu.hidden && !startMenu.contains(e.target) && e.target !== startButton) {
		startMenu.hidden = true;
	}
});

// ---------- Clock ----------

function tickClock() {
	document.getElementById("clock").textContent = new Date().toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}
tickClock();
setInterval(tickClock, 1000 * 15);

// ---------- Toast notifications + sound ----------

let audioCtx;
export function pingSound() {
	try {
		audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
		const osc = audioCtx.createOscillator();
		const gain = audioCtx.createGain();
		osc.type = "sine";
		osc.frequency.setValueAtTime(880, audioCtx.currentTime);
		gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
		osc.connect(gain).connect(audioCtx.destination);
		osc.start();
		osc.stop(audioCtx.currentTime + 0.4);
	} catch {
		// audio not available (e.g. before first user gesture) — ignore
	}
}

export function toast(title, message) {
	const el = document.createElement("div");
	el.className = "toast";
	el.innerHTML = `<div class="toast-title">${title}</div><div>${message}</div>`;
	toastLayer.appendChild(el);
	setTimeout(() => el.remove(), 9000);
}

// ---------- WebSocket: proactive notifications ----------

function connectSocket() {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(`${proto}//${location.host}/ws`);
	ws.addEventListener("open", () => connDot.classList.add("connected"));
	ws.addEventListener("close", () => {
		connDot.classList.remove("connected");
		setTimeout(connectSocket, 3000);
	});
	ws.addEventListener("error", () => ws.close());
	ws.addEventListener("message", (event) => {
		try {
			const data = JSON.parse(event.data);
			if (data.type === "notification") {
				toast("⏰ Autonomous Task", data.message);
				pingSound();
				document.dispatchEvent(new CustomEvent("voidclaw:notification", { detail: data }));
			}
		} catch {
			// ignore malformed frames
		}
	});
}

// ---------- Boot sequence ----------

const bootLines = [
	"[SYSTEM] Initializing VoidClaw kernel...",
	"[SYSTEM] Mounting sandboxed workspace...",
	"[SYSTEM] Loading neural vault (memory)...",
	"[SYSTEM] Starting autonomous scheduler...",
	"[SYSTEM] Establishing live channel...",
	"[SYSTEM] Welcome back.",
];

function runBoot() {
	const log = document.getElementById("boot-log");
	bootLines.forEach((line, i) => {
		setTimeout(() => {
			const div = document.createElement("div");
			div.textContent = line;
			log.appendChild(div);
		}, i * 280);
	});

	setTimeout(() => {
		document.getElementById("boot-screen").classList.add("hide");
		document.getElementById("desktop").hidden = false;
		openApp("terminal");
		connectSocket();
	}, 3200);
}

runBoot();
