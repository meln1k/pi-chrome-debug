// Side panel: one durable Harness on IndexedDB; each chat is a conversation, rendered from its watch.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
	type Conversation,
	type ConversationId,
	type ConversationView,
	type ConversationWatch,
	createRegistry,
	Harness,
	type LiveState,
} from "@earendil-works/pi-durable";
import { type CodemodeRemote, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import { FileTools, filesEnv } from "./files.ts";
import { PageTools, setPinnedTab } from "./page.ts";
import { DebuggerPrompt } from "./prompt.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// Tools stay on the tab the panel was opened on: capture it when the panel is shown, and keep it
// while the panel is hidden by a tab switch, so a run in flight never drifts to another tab.
const pinActiveTab = async () => {
	const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (t?.id !== undefined) setPinnedTab(t.id);
};
void pinActiveTab();
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") void pinActiveTab();
});
const log = $<HTMLDivElement>("log");
const input = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const chatsInput = $<HTMLSelectElement>("chats");
const dialog = $<HTMLDialogElement>("settings");
const providerInput = $<HTMLSelectElement>("provider");
const keyInput = $<HTMLInputElement>("key");
const modelInput = $<HTMLSelectElement>("model");
const thinkingInput = $<HTMLSelectElement>("thinking");

const DEFAULT_MODEL: Record<string, string> = { openrouter: "deepseek/deepseek-v4.1-flash", "opencode-go": "deepseek-v4.1-flash" };
const ENV_PROVIDER: Record<string, string> = { OPENROUTER_API_KEY: "openrouter", OPENCODE_API_KEY: "opencode-go" };

type Settings = { provider: string; keys: Record<string, string>; models: Record<string, string>; thinking?: ModelThinkingLevel };
type Chat = { id: ConversationId; title: string; at: number };
const old = (await chrome.storage.local.get(["key", "model", "settings", "chats"])) as {
	key?: string;
	model?: string;
	settings?: Settings;
	chats?: Chat[];
};
// Older versions stored one OpenRouter key and model.
const settings: Settings = old.settings ?? { provider: "openrouter", keys: { openrouter: old.key ?? "" }, models: { openrouter: old.model ?? DEFAULT_MODEL.openrouter } };
let chats: Chat[] = old.chats ?? [];
const catalog = (provider: string) => models.getModelsOfType("chat", provider);
// A saved model the provider no longer lists falls back to the default.
const modelRef = () => {
	const saved = settings.models[settings.provider];
	const ok = catalog(settings.provider).some((m) => m.id === saved);
	return { provider: settings.provider, modelId: ok ? saved! : DEFAULT_MODEL[settings.provider]! };
};
const currentModel = () => models.getModelOfType("chat", settings.provider, modelRef().modelId);
// Unset is the harness default, off.
const thinkingLevel = (): ModelThinkingLevel => {
	const model = currentModel();
	return model ? clampThinkingLevel(model, settings.thinking ?? "off") : "off";
};
const agentChange = () => ({ model: modelRef(), thinkingLevel: thinkingLevel() });
const hasKey = () => !!settings.keys[settings.provider];

const models = createModels({
	authContext: { env: async (name) => settings.keys[ENV_PROVIDER[name] ?? ""] || undefined, fileExists: async () => false },
	identity: { attribution: { name: "pi-debugger", url: "https://github.com/earendil-works/pi" } },
});
models.setProvider(openrouterProvider());
models.setProvider(opencodeGoProvider());

const showSettings = () => {
	providerInput.value = settings.provider;
	keyInput.value = settings.keys[settings.provider] ?? "";
	modelInput.replaceChildren(
		...[...catalog(settings.provider)].sort((a, b) => a.name.localeCompare(b.name)).map((m) => new Option(m.name, m.id)),
	);
	modelInput.value = modelRef().modelId;
	// Only the levels the model supports; a saved level it lacks snaps to the nearest one it has.
	const model = currentModel();
	const levels = model ? getSupportedThinkingLevels(model) : (["off"] as ModelThinkingLevel[]);
	thinkingInput.replaceChildren(...levels.map((l) => new Option(`Thinking ${l}`, l)));
	thinkingInput.value = thinkingLevel();
};
showSettings();
const save = async () => {
	await chrome.storage.local.set({ settings });
	await conv.configure(agentChange(), ctx);
};
providerInput.onchange = () => {
	settings.provider = providerInput.value;
	showSettings();
	void save();
};
keyInput.onchange = () => {
	settings.keys[settings.provider] = keyInput.value.trim();
	void save();
};
modelInput.onchange = () => {
	settings.models[settings.provider] = modelInput.value;
	showSettings();
	void save();
};
thinkingInput.onchange = () => {
	settings.thinking = thinkingInput.value as ModelThinkingLevel;
	void save();
};
$("settings-btn").onclick = () => dialog.showModal();

const registry = createRegistry();
registry.install(DebuggerPrompt);
registry.install(PageTools);
registry.install(FileTools);
// Code mode: the model writes a JS script that calls the page tools as tools.<name>(args) in a QuickJS VM.
// The VM runs in a Web Worker, one per script, so a script that computes never blocks the panel.
let launching: Set<Worker> | undefined;
const workerRemote = (): CodemodeRemote => {
	const worker = new Worker("codemode-worker.js", { type: "module" });
	launching?.add(worker);
	return {
		execute: (request, exchange) =>
			new Promise<void>((resolve) => {
				worker.onmessage = async ({ data }) => {
					if (data.done) return resolve();
					worker.postMessage({ id: data.id, reply: await exchange(data.messages).catch(() => ({ type: "stop" as const })) });
				};
				worker.onerror = () => resolve(); // no terminal message: the sandbox reports kind "sandbox"
				worker.postMessage({ request });
			}),
	};
};
// pi's remote sandbox can only stop a VM at its next tool call; a worker can be killed. start() launches the VM
// synchronously, so the workers created during super.start() belong to that run and die when it ends, however it ends.
class WorkerSandbox extends RemoteCodemodeSandbox {
	override start(...args: Parameters<RemoteCodemodeSandbox["start"]>) {
		const workers = (launching = new Set());
		try {
			const run = super.start(...args);
			void run.result.finally(() => workers.forEach((w) => w.terminate()));
			return run;
		} finally {
			launching = undefined;
		}
	}
}
registry.install(
	createCodemodeExtension({
		sandbox: new WorkerSandbox({ timeoutMs: 120_000, remote: workerRemote }),
		models: false,
	}),
);

// One owner per IndexedDB database: a second panel (other window) waits here until the first closes.
const harness = await new Promise<Harness>((resolve) =>
	navigator.locks.request("pi-debugger", async () => {
		const storage = await IndexedDbStorage.open("pi-debugger");
		const h = await Harness.open(storage, { models, registry, env: () => filesEnv }, ctx);
		resolve(h);
		await h.closed;
	}),
);
addEventListener("pagehide", () => void harness.close(ctx));
// Older versions had a single chat: the root conversation.
if (!chats.length) chats = [{ id: (await harness.root(ctx, { agent: agentChange() })).id, title: "New chat", at: Date.now() }];
harness.resume();

// ponytail: chat list lives in chrome.storage next to settings; move into a durable doc if it needs to sync with the transcript
const saveChats = () => chrome.storage.local.set({ chats });
const renderChats = (current: ConversationId) => {
	chats.sort((a, b) => b.at - a.at);
	chatsInput.replaceChildren(...chats.slice(0, 30).map((c) => new Option(c.title, String(c.id), false, c.id === current)));
};

let conv: Conversation;
let watch: ConversationWatch | undefined;
async function openChat(id: ConversationId) {
	await watch?.stop();
	conv = (await harness.conversation(id, ctx))!;
	await conv.configure(agentChange(), ctx);
	renderChats(id);
	watch = await conv.watch(ctx);
	render(watch.value);
	watch.start(async (v) => render(v));
	input.focus();
}
chatsInput.onchange = () => void openChat(Number(chatsInput.value) as unknown as ConversationId);
$("new").onclick = async () => {
	if (chats.find((c) => c.id === conv.id)?.title === "New chat") return input.focus(); // already on an empty chat
	const c = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: agentChange() }, ctx);
	chats.push({ id: c.id, title: "New chat", at: Date.now() });
	await saveChats();
	await openChat(c.id);
};

const el = (cls: string, text: string, tag = "div") => {
	const e = document.createElement(tag);
	e.className = cls;
	e.textContent = text;
	return e;
};
const short = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}…` : s);
// Every details the user opened, keyed by its place in the transcript, so re-renders keep it open.
const openDetails = new Set<string>();
const details = (key: string, cls: string) => {
	const d = document.createElement("details");
	d.className = cls;
	d.open = openDetails.has(key);
	d.addEventListener("toggle", () => (d.open ? openDetails.add(key) : openDetails.delete(key)));
	return d;
};
const userText = (c: string | { type: string; text?: string }[]) => (typeof c === "string" ? c : c.map((p) => p.text ?? "[image]").join(""));

function render(view: ConversationView) {
	const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
	const out: HTMLElement[] = [];
	const messages = view.entries.flatMap((e) => e.model ?? []);
	const live = view.docs["pi.live"] as LiveState | undefined;
	if (live?.generation?.message) messages.push(live.generation.message as any);

	// A chat is titled by its first message.
	const chat = chats.find((c) => c.id === view.conversation.id);
	const first = messages.find((m) => m.role === "user");
	if (chat?.title === "New chat" && first?.role === "user") {
		chat.title = short(userText(first.content).replace(/\s+/g, " "), 60);
		void saveChats();
		renderChats(chat.id);
	}

	// Thinking and tool calls between two agent messages collapse into one row.
	let run: { el: HTMLDetailsElement; key: string; tools: Map<string, number> } | undefined;
	const flush = () => {
		if (!run) return;
		const total = [...run.tools.values()].reduce((a, b) => a + b, 0);
		const names = [...run.tools].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).slice(0, 3).join(", ");
		run.el.prepend(el("", total ? `Ran ${total} tool ${total === 1 ? "call" : "calls"}${names ? ` · ${names}` : ""}` : "Thinking", "summary"));
		out.push(run.el);
		run = undefined;
	};
	const group = (key: string, node: HTMLElement, tool?: string) => {
		if (!run || run.key !== key) {
			flush();
			run = { el: details(key, "run"), key, tools: new Map() };
		}
		run.el.append(node);
		if (tool) run.tools.set(tool, (run.tools.get(tool) ?? 0) + 1);
	};

	// A run ends only at a user message or agent text, so thinking and tools from several
	// messages still form one row; breakAt keeps its key stable across re-renders.
	let breakAt = -1;
	messages.forEach((m, i) => {
		const key = `run-${view.conversation.id}-${breakAt}`;
		if (m.role === "user") {
			flush();
			breakAt = i;
			out.push(el("user", userText(m.content)));
		} else if (m.role === "assistant") {
			m.content.forEach((c, ci) => {
				if (c.type === "thinking" && c.thinking.trim()) {
					const d = details(`t-${view.conversation.id}-${i}-${ci}`, "thinking");
					d.append(el("", c.redacted ? "Thinking (redacted)" : "Thinking", "summary"), el("", c.thinking));
					group(key, d);
				}
				if (c.type === "text" && c.text.trim()) {
					flush();
					breakAt = i;
					out.push(el("assistant", c.text));
				}
				if (c.type === "toolCall") {
					const d = details(`c-${view.conversation.id}-${i}-${ci}`, "tool");
					d.append(el("", `▸ ${c.name} ${short(JSON.stringify(c.arguments), 120)}`, "summary"), el("", JSON.stringify(c.arguments, null, 1), "pre"));
					group(key, d, c.name);
				}
			});
			if (m.stopReason === "error") {
				flush();
				out.push(el("error", m.errorMessage ?? "model error"));
			}
		} else if (m.role === "toolResult") {
			const d = details(`r-${view.conversation.id}-${i}`, `result${m.isError ? " error" : ""}`);
			const body = m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
			d.append(el("", `◂ ${m.toolName}: ${short(body.split("\n")[0] ?? "", 100)}`, "summary"), el("", short(body, 5000), "pre"));
			group(key, d);
		}
	});
	flush();
	if (live?.generation?.retry) out.push(el("error", `Retrying: ${live.generation.retry.error}`));
	if (!out.length) out.push(el("empty", hasKey() ? "Ask anything about the page in your active tab." : "Add an API key in settings to start."));
	log.replaceChildren(...out);

	const running = live?.tools?.find((t) => t.status === "running");
	const last = live?.generation?.message?.content.at(-1);
	$("status").textContent = !live?.run ? "" : running ? `Running ${running.name}` : last?.type === "thinking" ? "Thinking" : "Streaming";
	document.body.toggleAttribute("data-busy", !!live?.run);
	syncSend();
	if (atBottom) log.scrollTop = log.scrollHeight;
}

const syncSend = () => {
	const busy = document.body.hasAttribute("data-busy");
	sendBtn.disabled = !busy && !input.value.trim();
	sendBtn.ariaLabel = busy ? "Stop" : "Send";
};
input.oninput = syncSend;

async function send() {
	const content = input.value.trim();
	if (!content) return;
	if (!hasKey()) return dialog.showModal();
	input.value = "";
	syncSend();
	const chat = chats.find((c) => c.id === conv.id);
	if (chat) chat.at = Date.now();
	void saveChats();
	await conv.submit({ type: "input", content }, ctx);
}
sendBtn.onclick = () => (document.body.hasAttribute("data-busy") ? void conv.abort(ctx) : void send());
input.onkeydown = (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		void send(); // while busy this queues as a follow-up
	}
};

await openChat(chats.reduce((a, b) => (b.at > a.at ? b : a)).id);
if (!hasKey()) dialog.showModal();
document.body.dataset.ready = "1";
