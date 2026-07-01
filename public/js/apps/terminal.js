/**
 * VoidClaw Terminal — the primary chat/ReAct interface.
 */
export function mountTerminal(root) {
	root.innerHTML = `
		<div class="app-root">
			<div class="term-log" id="term-log"></div>
			<div class="term-input-row">
				<textarea id="term-input" placeholder="Talk to VoidClaw... (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
				<button class="btn" id="term-send">Send</button>
			</div>
		</div>
	`;

	const log = root.querySelector("#term-log");
	const input = root.querySelector("#term-input");
	const sendBtn = root.querySelector("#term-send");
	let busy = false;

	function appendLine(tagClass, tagLabel, text) {
		const line = document.createElement("div");
		line.className = "term-line";
		line.innerHTML = `<span class="tag ${tagClass}">${tagLabel}</span>`;
		const span = document.createElement("span");
		span.textContent = text;
		line.appendChild(span);
		log.appendChild(line);
		log.scrollTop = log.scrollHeight;
		return span;
	}

	appendLine("tag-final", "𒆙 VOIDCLAW »", "Systems online. What can I help you with?");

	async function send() {
		const text = input.value.trim();
		if (!text || busy) return;
		busy = true;
		input.value = "";
		input.style.height = "auto";
		sendBtn.disabled = true;

		appendLine("tag-you", "👤 YOU »", text);

		try {
			const res = await fetch("/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: text }),
			});
			if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				let idx;
				while ((idx = buffer.indexOf("\n\n")) !== -1) {
					const rawEvent = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data:"));
					if (!dataLine) continue;
					const payload = JSON.parse(dataLine.slice(5).trim());
					renderStep(payload);
				}
			}
		} catch (err) {
			appendLine("tag-error", "[!] ERROR »", err.message || String(err));
		} finally {
			busy = false;
			sendBtn.disabled = false;
			input.focus();
		}
	}

	function renderStep(step) {
		if (step.type === "thought") appendLine("tag-thought", "💭 THOUGHT »", step.text);
		else if (step.type === "action") appendLine("tag-action", "🛠 ACTION »", step.text);
		else if (step.type === "observation") appendLine("tag-observe", "👁 OBSERVE »", step.text);
		else if (step.type === "final") appendLine("tag-final", "𒆙 VOIDCLAW »", step.text);
		else if (step.type === "error") appendLine("tag-error", "[!] ERROR »", step.text);
	}

	input.addEventListener("input", () => {
		input.style.height = "auto";
		input.style.height = `${input.scrollHeight}px`;
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	});
	sendBtn.addEventListener("click", send);

	function onNotification(e) {
		appendLine("tag-observe", "⏰ AUTONOMOUS »", e.detail.message);
	}
	document.addEventListener("voidclaw:notification", onNotification);

	return () => document.removeEventListener("voidclaw:notification", onNotification);
}
