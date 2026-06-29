/**
 * Ornith OS dashboard frontend.
 *
 * Talks to the FastAPI JSON API on Vercel. Every request carries ?agent_id= so
 * the backend routes it to the right agent (state in Neon). Default agent: "main".
 */

const SESSION_ID = "web";
let currentAgent = "main";

const $ = (id) => document.getElementById(id);

async function api(path, { method = "GET", body, agent = currentAgent } = {}) {
  // Merge agent_id into the path's existing query string (if any) safely.
  const url = new URL(`/api/${path}`, window.location.origin);
  url.searchParams.set("agent_id", agent);
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// --- Agents sidebar ----------------------------------------------------------

async function loadAgents() {
  const list = $("agentList");
  list.innerHTML = "";
  // The default "main" agent is always present.
  const agents = [{ agent_id: "main", name: "main" }];
  try {
    const data = await api("agents");
    for (const a of data.agents || []) agents.push(a);
  } catch (_) {}

  for (const a of agents) {
    const el = document.createElement("div");
    el.className = "agent-item" + (a.agent_id === currentAgent ? " active" : "");
    el.append(document.createTextNode(a.name));
    const small = document.createElement("small");
    small.textContent = a.agent_id;
    el.appendChild(small);
    el.onclick = () => selectAgent(a.agent_id);
    list.appendChild(el);
  }
}

async function selectAgent(id) {
  currentAgent = id;
  await loadAgents();
  await loadHistory();
  await loadConfig();
  await loadTasks();
}

$("spawnBtn").onclick = async () => {
  const name = prompt("Agent name?");
  if (!name) return;
  const instructions =
    prompt("Instructions / role for this agent?") || "You are a helpful specialist agent.";
  const data = await api("agents", { method: "POST", body: { name, instructions } });
  await selectAgent(data.agent_id);
};

// --- Chat --------------------------------------------------------------------

function addMessage(role, content, reasoning, steps, source) {
  const chat = $("chat");
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "You" : `${currentAgent}${source ? " · " + source : ""}`;
  wrap.appendChild(who);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = content;
  wrap.appendChild(bubble);

  if (steps && steps.length) {
    const s = document.createElement("div");
    s.className = "steps";
    s.textContent = "🔧 " + steps.map((t) => `${t.tool}() → ${t.output}`).join("  ·  ");
    wrap.appendChild(s);
  }

  if (reasoning) {
    const toggle = document.createElement("div");
    toggle.className = "toggle-reasoning";
    toggle.textContent = "▸ reasoning";
    const r = document.createElement("div");
    r.className = "reasoning";
    r.textContent = reasoning;
    toggle.onclick = () => {
      r.classList.toggle("show");
      toggle.textContent = r.classList.contains("show") ? "▾ reasoning" : "▸ reasoning";
    };
    wrap.appendChild(toggle);
    wrap.appendChild(r);
  }

  chat.appendChild(wrap);
  chat.scrollIntoView(false);
  wrap.scrollIntoView({ behavior: "smooth", block: "end" });
  return bubble;
}

async function loadHistory() {
  $("chat").innerHTML = "";
  try {
    const data = await api(`history?session_id=${SESSION_ID}`);
    for (const m of data.messages || []) {
      addMessage(m.role, m.content, m.reasoning);
    }
  } catch (_) {}
}

async function send() {
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  const agentAtSend = currentAgent;
  input.value = "";
  addMessage("user", text);
  const pending = addMessage("assistant", "…thinking");
  try {
    const data = await api("chat", {
      method: "POST",
      agent: agentAtSend,
      body: { session_id: SESSION_ID, message: text },
    });
    pending.parentElement.remove();
    // Drop the reply if the user switched agents while it was in flight.
    if (currentAgent === agentAtSend) {
      addMessage("assistant", data.content, data.reasoning, data.steps, data.source);
    }
  } catch (e) {
    pending.textContent = "⚠️ " + e.message;
  }
}

$("sendBtn").onclick = send;
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// --- Scheduled tasks ---------------------------------------------------------

async function loadTasks() {
  try {
    const data = await api("tasks");
    const list = $("taskList");
    list.innerHTML = "";
    for (const t of data.tasks || []) {
      const el = document.createElement("div");
      el.className = "card";
      const title = document.createElement("b");
      title.textContent = t.prompt;
      const meta = document.createElement("div");
      meta.className = "src";
      meta.textContent = `every ${t.every_minutes} min · next run ${new Date(
        t.next_run,
      ).toLocaleTimeString()}`;
      el.append(title, meta);
      list.appendChild(el);
    }
  } catch (_) {}
}

$("addTaskBtn").onclick = async () => {
  const prompt = $("taskPrompt").value.trim();
  if (!prompt) return;
  await api("schedule", {
    method: "POST",
    body: { prompt, every_minutes: Number($("taskEvery").value) || 60 },
  });
  $("taskPrompt").value = "";
  await loadTasks();
};

// --- Config ------------------------------------------------------------------

async function loadConfig() {
  try {
    const data = await api("config");
    $("cfgName").value = data.name || "";
    $("cfgInstructions").value = data.instructions || "";
  } catch (_) {}
}

$("saveCfgBtn").onclick = async () => {
  await api("config", {
    method: "POST",
    body: { name: $("cfgName").value, instructions: $("cfgInstructions").value },
  });
  $("srcLabel").textContent = "Saved.";
  await loadAgents();
};

// --- Tabs --------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.view).classList.add("active");
    $("composer").style.display = tab.dataset.view === "chatView" ? "flex" : "none";
  };
});

// --- Init --------------------------------------------------------------------

selectAgent("main");
