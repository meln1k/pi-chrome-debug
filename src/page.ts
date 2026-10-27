// Page tools: everything goes through the Chrome DevTools Protocol on the attached tab.
import { Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { addExport, base64FromBytes, bytesFromBase64, callers, disasm, fmtType, parseWasm, patchBody, type WasmFunc, type WasmModule, xrefs } from "./wasm.ts";

type TabLog = {
	console: string[];
	network: Map<string, Req>;
	hooks: HookCall[];
	pauses: Pause[];
	scripts: Map<string, string>;
	wasmScripts: Map<string, WasmScript>;
	bps: Map<string, Bp>;
	dbg: boolean;
	module?: { scriptId: string; parsed: WasmModule };
	patched?: { bytes: Uint8Array; label: string };
};
type HookCall = { t: number; target: string; args: string[]; stack: string[] };
type WasmScript = { id: string; url: string };
type Bp = { breakpointId: string; scriptId: string; offset: number };
type PauseFrame = { fn: string; wasm: boolean; url?: string; offset?: number; line?: number; locals?: string };
type Pause = { t: number; reason: string; bps: string[]; frames: PauseFrame[] };
type Req = { id: string; method: string; url: string; type?: string; status?: number; error?: string; reqBody?: string };

const LOG_CAP = 500; // ponytail: in-memory ring buffers, lost when the panel closes; persist in IndexedDB if needed
const logs = new Map<number, TabLog>();

const send = (tabId: number, method: string, params?: object) =>
	chrome.debugger.sendCommand({ tabId }, method, params) as Promise<any>;

chrome.debugger.onDetach.addListener((src) => {
	if (src.tabId === undefined) return;
	logs.delete(src.tabId);
	preloads.delete(src.tabId);
});
chrome.debugger.onEvent.addListener((src, method, p: any) => {
	const log = src.tabId === undefined ? undefined : logs.get(src.tabId);
	if (!log) return;
	const push = (line: string) => log.console.push(line) > LOG_CAP && log.console.shift();
	if (method === "Runtime.bindingCalled" && p.name === "__piHook") {
		// Reported through a CDP binding rather than kept in the page, so captured calls survive reloads.
		if (log.hooks.push(JSON.parse(p.payload)) > LOG_CAP) log.hooks.shift();
	} else if (method === "Runtime.consoleAPICalled") {
		const args = p.args.map((a: any) => a.value ?? a.unserializableValue ?? a.description ?? a.type).join(" ");
		const at = p.stackTrace?.callFrames?.[0];
		push(`[${p.type}] ${args}${at ? `  (${at.url}:${at.lineNumber + 1})` : ""}`);
	} else if (method === "Runtime.exceptionThrown") {
		const d = p.exceptionDetails;
		push(`[uncaught] ${d.exception?.description ?? d.text}  (${d.url ?? ""}:${d.lineNumber + 1})`);
	} else if (method === "Log.entryAdded") {
		push(`[${p.entry.level}:${p.entry.source}] ${p.entry.text}${p.entry.url ? `  (${p.entry.url})` : ""}`);
	} else if (method === "Network.requestWillBeSent") {
		const r = p.request;
		log.network.set(p.requestId, { id: p.requestId, method: r.method, url: r.url, type: p.type, reqBody: r.postData });
		if (log.network.size > LOG_CAP) log.network.delete(log.network.keys().next().value!);
	} else if (method === "Network.responseReceived") {
		const req = log.network.get(p.requestId);
		if (req) req.status = p.response.status;
	} else if (method === "Network.loadingFailed") {
		const req = log.network.get(p.requestId);
		if (req) req.error = p.errorText;
	} else if (method === "Debugger.scriptParsed") {
		if (p.url) log.scripts.set(p.scriptId, p.url);
		if (p.scriptLanguage === "WebAssembly") log.wasmScripts.set(p.scriptId, { id: p.scriptId, url: p.url || `wasm script ${p.scriptId}` });
	} else if (method === "Debugger.paused") {
		void recordPause(src.tabId!, log, p);
	} else if (method === "Fetch.requestPaused") {
		// The pattern can match HTML too (e.g. *wasm* matches wasm-deep.html); only replace wasm bodies.
		const isWasm = (p.responseHeaders ?? []).some((h: any) => /^content-type$/i.test(h.name) && /application\/wasm/i.test(h.value)) || /\.wasm(\?|$)/i.test(p.request.url ?? "");
		if (log.patched && isWasm) {
			// The body may change size and is no longer encoded: drop the headers that describe the original.
			const headers = (p.responseHeaders ?? []).filter((h: any) => !/^(content-length|content-encoding|transfer-encoding)$/i.test(h.name));
			void send(src.tabId!, "Fetch.fulfillRequest", {
				requestId: p.requestId,
				responseCode: p.responseStatusCode ?? 200,
				responseHeaders: headers,
				body: base64FromBytes(log.patched.bytes),
			}).catch(() => {});
		} else void send(src.tabId!, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
	}
});

/** Snapshot a pause, then resume: a paused page blocks every other tool. */
async function recordPause(tabId: number, log: TabLog, p: any) {
	const frames: PauseFrame[] = [];
	try {
		for (const f of p.callFrames.slice(0, 15)) {
			const wasm = log.wasmScripts.has(f.location.scriptId);
			const frame: PauseFrame = { fn: f.functionName || "(anonymous)", wasm, url: wasm ? log.wasmScripts.get(f.location.scriptId)!.url : (log.scripts.get(f.location.scriptId) ?? f.url) };
			if (wasm) {
				frame.offset = f.location.columnNumber;
				const scope = f.scopeChain.find((s: any) => s.type === "local");
				if (scope) {
					const { result } = await send(tabId, "Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true });
					const locals: string[] = [];
					for (const { name } of result.slice(0, 10)) {
						const r = await send(tabId, "Debugger.evaluateOnCallFrame", { callFrameId: f.callFrameId, expression: name, returnByValue: true, silent: true }).catch(() => undefined);
						const v = r?.result?.value;
						locals.push(`${name}=${v && typeof v === "object" ? `${v.type} ${v.value}` : String(r?.result?.unserializableValue ?? v)}`);
					}
					if (locals.length) frame.locals = locals.join(", ");
				}
			} else {
				frame.line = f.location.lineNumber + 1;
			}
			frames.push(frame);
		}
	} catch {
		// keep the frames captured so far
	}
	const bps = (p.hitBreakpoints ?? []).map((id: string) => [...log.bps].find(([, b]) => b.breakpointId === id)?.[0]).filter(Boolean);
	if (log.pauses.push({ t: Date.now(), reason: p.reason, bps, frames }) > LOG_CAP) log.pauses.shift();
	await send(tabId, "Debugger.resume").catch(() => {});
}

/** The tab the panel was opened on, set by the background on the action click. */
let pinned: number | undefined;
export const setPinnedTab = (id: number | undefined) => {
	pinned = id;
};

/** The pinned tab, with the debugger attached and logging. */
async function tab(): Promise<number> {
	const wanted = pinned ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
	if (wanted === undefined) throw new Error("No tab");
	const t = await chrome.tabs.get(wanted).catch(() => {
		throw new Error("The tab this panel was opened on is gone; close the panel and open it again on a tab");
	});
	const id = t.id!;
	if (!logs.has(id)) {
		const target = { tabId: id };
		try {
			await chrome.debugger.attach(target, "1.3");
		} catch (e) {
			if (!String(e).includes("Another debugger")) throw new Error(`Cannot debug ${t.url}: ${e}`);
			// Usually our own session left over from an earlier panel: drop it and attach fresh.
			await chrome.debugger.detach(target).catch(() => {});
			await chrome.debugger.attach(target, "1.3").catch((e2) => {
				throw new Error(`Another tool or extension is debugging ${t.url}; close it and retry (${e2})`);
			});
		}
		logs.set(id, { console: [], network: new Map(), hooks: [], pauses: [], scripts: new Map(), wasmScripts: new Map(), bps: new Map(), dbg: false });
		await Promise.all(["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"].map((m) => send(id, m)));
		await send(id, "Runtime.addBinding", { name: "__piHook" });
	}
	return id;
}

/** One CDP command on the attached tab; reattaches once if the session was dropped (user cancelled the banner, crash). */
async function cmd(method: string, params?: object): Promise<any> {
	const id = await tab();
	try {
		return await send(id, method, params);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!/not attached/i.test(msg)) throw new Error(`${method} failed: ${msg}`);
		logs.delete(id);
		return send(await tab(), method, params);
	}
}

const text = (s: string) => ({ output: [{ type: "text" as const, text: s }] });

/** Page.captureScreenshot never returns for a hidden tab, so bring the attached tab forward and bound the wait. */
async function capture(params: object) {
	const id = await tab();
	const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (active?.id !== id) await chrome.tabs.update(id, { active: true });
	const shot = cmd("Page.captureScreenshot", params);
	shot.catch(() => {});
	const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Page.captureScreenshot timed out; the tab could not be brought to the front")), 10_000));
	return (await Promise.race([shot, timeout])) as { data: string };
}

const pageEval = defineTool({
	name: "page_eval",
	description:
		"Run JavaScript in the page's main world (same globals as the page's own scripts, CSP bypassed). Top-level await works, and a returned promise is awaited. " +
		"The value of the last expression is returned as JSON, so return plain data (e.g. el.outerHTML, not el); a body with return statements works too. " +
		"In codemode, tools.page_eval resolves to the value itself, so return objects rather than JSON.stringify-ing them. " +
		"Use it to read or change DOM, window globals, framework state, localStorage/sessionStorage, cookies, or to call fetch as the page.",
	parameters: Type.Object({ code: Type.String({ description: "JavaScript; the last expression is the result" }) }),
	// codemode scripts get the value itself, not its JSON text.
	structuredOutputSchema: Type.Any(),
	execute: async ({ code }) => {
		let r = await evaluate(code);
		// A body with `return` statements: run it as an async function body instead.
		if (/Illegal return statement/.test(r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? "")) {
			r = await evaluate(`(async () => {\n${code}\n})()`);
		}
		if (r.exceptionDetails) {
			return { ...text(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text), isError: true };
		}
		const v = r.result;
		if (v.type === "undefined") return { ...text("undefined"), structuredOutput: null };
		if (v.type === "function") return { ...text(`[function, not called] ${String(v.description).slice(0, 200)}`), structuredOutput: null };
		return { ...text(v.unserializableValue ?? JSON.stringify(v.value, null, 1) ?? v.description), structuredOutput: v.value ?? v.unserializableValue ?? null };
	},
});

let evalGroups = 0;
/** Evaluate in the page and return the result by value, awaiting a returned promise. */
async function evaluate(expression: string) {
	// One object group per call: parallel calls sharing a group freed each other's promises mid-await.
	const objectGroup = `pi-${evalGroups++}`;
	try {
		const r = await cmd("Runtime.evaluate", { expression, replMode: true, awaitPromise: true, objectGroup, userGesture: true, allowUnsafeEvalBlockedByCSP: true });
		const v = r.result;
		if (r.exceptionDetails || !v.objectId) return r;
		// REPL mode does not await a returned promise, and returnByValue would turn it into {}: await it here.
		if (v.subtype === "promise") return await cmd("Runtime.awaitPromise", { promiseObjectId: v.objectId, returnByValue: true });
		if (v.type === "object") return await cmd("Runtime.callFunctionOn", { objectId: v.objectId, functionDeclaration: "function () { return this; }", returnByValue: true });
		return r;
	} finally {
		void cmd("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
	}
}

const lastViewport = new Map<number, string>();

const screenshot = defineTool({
	name: "page_screenshot",
	description:
		"Screenshot of the visible part of the attached tab, scaled so 1 image pixel = 1 CSS pixel of the viewport (at zoom 1), whatever the devicePixelRatio. " +
		"Image coordinates plus the crop origin are viewport coordinates, the units page_mouse takes. Reports viewport size, devicePixelRatio and scroll.",
	parameters: Type.Object({
		crop: Type.Optional(
			Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() }, { description: "Viewport region in CSS px; default the whole viewport" }),
		),
		zoom: Type.Optional(Type.Number({ description: "Magnify the crop, e.g. 2 for small text; default 1" })),
	}),
	// codemode scripts get { info, image }; image(shot.image) shows it to the model.
	structuredOutputSchema: Type.Object({ info: Type.String(), image: Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }) }),
	execute: async ({ crop, zoom = 1 }) => {
		const { cssVisualViewport: vp } = await cmd("Page.getLayoutMetrics");
		const dpr = (await cmd("Runtime.evaluate", { expression: "devicePixelRatio", returnByValue: true })).result.value as number;
		const c = crop ?? { x: 0, y: 0, width: vp.clientWidth, height: vp.clientHeight };
		const { data } = await capture({
			format: "jpeg",
			quality: 70,
			// clip is in document coordinates; scale 1/dpr undoes the device pixel ratio.
			clip: { x: vp.pageX + c.x, y: vp.pageY + c.y, width: c.width, height: c.height, scale: zoom / dpr },
		});
		const map =
			zoom === 1 && !crop
				? "image (x, y) = viewport (x, y)"
				: `viewport x = ${c.x} + imageX / ${zoom}, viewport y = ${c.y} + imageY / ${zoom}`;
		const size = `${Math.round(vp.clientWidth)}x${Math.round(vp.clientHeight)} @${dpr}`;
		const tabId = await tab();
		const before = lastViewport.get(tabId);
		lastViewport.set(tabId, size);
		const warn = before && before !== size ? `WARNING: viewport changed from ${before} to ${size} since the last screenshot; coordinates taken earlier are stale. ` : "";
		const info = `${warn}Viewport ${Math.round(vp.clientWidth)}x${Math.round(vp.clientHeight)} CSS px, devicePixelRatio ${dpr}, scrolled to (${Math.round(vp.pageX)}, ${Math.round(vp.pageY)}). Image ${Math.round(c.width * zoom)}x${Math.round(c.height * zoom)}: ${map}.`;
		const image = { type: "image" as const, data, mimeType: "image/jpeg" };
		return { output: [{ type: "text" as const, text: info }, image], structuredOutput: { info, image } };
	},
});

// Trusted input through Input.*: apps that ignore synthetic events (canvas, games, isTrusted checks) see real ones.
const describeAt = (x: number, y: number) =>
	cmd("Runtime.evaluate", {
		returnByValue: true,
		expression: `(() => { const e = document.elementFromPoint(${x}, ${y}); if (!e) return "nothing (outside the viewport)";
			return e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).join(".") : "")
				+ (e.tagName === "IFRAME" ? " (the event goes into this iframe)" : "") + ' "' + (e.innerText || e.value || "").trim().slice(0, 40) + '"'; })()`,
	}).then((r) => r.result.value as string);

let pressed: "left" | "middle" | "right" | undefined;
const mouse = defineTool({
	name: "page_mouse",
	// Input must land in order, and the effect report must not see another call's effects.
	executionMode: "sequential",
	description:
		"Real (trusted) mouse input on the attached tab, at viewport coordinates in CSS px (the units of page_screenshot's image), or at the center of a CSS selector, which is scrolled into view. " +
		"Not canvas backing-store pixels. Use down/move/up to drag. Returns the element that was under the pointer.",
	parameters: Type.Object({
		action: Type.Optional(Type.Union([Type.Literal("click"), Type.Literal("double"), Type.Literal("down"), Type.Literal("up"), Type.Literal("move")], { description: "Default click" })),
		x: Type.Optional(Type.Number()),
		y: Type.Optional(Type.Number()),
		selector: Type.Optional(Type.String({ description: "Instead of x/y; main document only" })),
		button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])),
	}),
	execute: async ({ action = "click", x, y, selector, button = "left" }) => {
		if (selector !== undefined) {
			const r = await cmd("Runtime.evaluate", {
				returnByValue: true,
				expression: `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center", inline: "center" });
					const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
			});
			if (!r.result.value) return { ...text(`No element matches ${selector}`), isError: true };
			({ x, y } = r.result.value);
		}
		if (x === undefined || y === undefined) return { ...text("Pass x and y, or selector"), isError: true };
		const hit = await describeAt(x, y);
		// Effect signal for canvas apps, where the element under the pointer says nothing: DOM mutations and pixels near the point.
		const near = async () => {
			const { cssVisualViewport: vp } = await cmd("Page.getLayoutMetrics");
			return (await capture({ format: "png", clip: { x: vp.pageX + x! - 60, y: vp.pageY + y! - 60, width: 120, height: 120, scale: 1 } })).data as string;
		};
		await cmd("Runtime.evaluate", {
			expression: `globalThis.__piObs?.disconnect(); globalThis.__piMut = 0; globalThis.__piObs = new MutationObserver((r) => (globalThis.__piMut += r.length));
				globalThis.__piObs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });`,
		});
		const pixelsBefore = await near();
		const ev = (type: string, extra: object = {}) => cmd("Input.dispatchMouseEvent", { type, x, y, ...extra });
		const press = async (clickCount: number) => {
			await ev("mousePressed", { button, buttons: 1, clickCount });
			await ev("mouseReleased", { button, buttons: 0, clickCount });
		};
		await ev("mouseMoved", pressed ? { button: pressed, buttons: 1 } : {});
		if (action === "click") await press(1);
		if (action === "double") {
			await press(1);
			await press(2);
		}
		if (action === "down") {
			pressed = button;
			await ev("mousePressed", { button, buttons: 1, clickCount: 1 });
		}
		if (action === "up") {
			await ev("mouseReleased", { button: pressed ?? button, buttons: 0, clickCount: 1 });
			pressed = undefined;
		}
		await new Promise((r) => setTimeout(r, 200));
		const changed = (await near()) !== pixelsBefore;
		const mutations = (await cmd("Runtime.evaluate", { expression: "globalThis.__piObs?.disconnect(); globalThis.__piMut", returnByValue: true })).result.value ?? 0;
		return text(
			`${action} at (${Math.round(x)}, ${Math.round(y)}) on ${hit}. Afterwards: ${mutations} DOM mutations, pixels within 60 px ${changed ? "changed" : "unchanged"}` +
				(mutations || changed ? "." : " (the input may have had no effect; check with a screenshot)."),
		);
	},
});

const NAMED: Record<string, number> = {
	Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
	Home: 36, End: 35, PageUp: 33, PageDown: 34, Shift: 16, Control: 17, Alt: 18, Meta: 91,
};
const MODIFIERS: Record<string, number> = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Cmd: 4, Shift: 8 };
/** DOM key, code, keyCode and typed text for a key name ("Escape", "F5", "w", "7", "é"). */
function keyInfo(k: string) {
	if (k === "Space" || k === " ") return { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " };
	if (NAMED[k]) return { key: k, code: ({ Shift: "ShiftLeft", Control: "ControlLeft", Alt: "AltLeft", Meta: "MetaLeft" } as Record<string, string>)[k] ?? k, windowsVirtualKeyCode: NAMED[k], text: k === "Enter" ? "\r" : undefined };
	if (/^F\d{1,2}$/.test(k)) return { key: k, code: k, windowsVirtualKeyCode: 111 + Number(k.slice(1)) };
	const up = k.toUpperCase();
	const code = /^[a-z]$/i.test(k) ? `Key${up}` : /^\d$/.test(k) ? `Digit${k}` : "";
	return { key: k, code, windowsVirtualKeyCode: /^[a-z0-9]$/i.test(k) ? up.charCodeAt(0) : 0, text: k };
}
async function pressKey(combo: string, holdMs = 0) {
	const parts = combo === "+" ? ["+"] : combo.split("+");
	const name = parts.pop()!;
	const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p] ?? 0), 0);
	const { text: typed, ...info } = keyInfo(name);
	const withText = typed !== undefined && !(modifiers & 6); // Ctrl/Meta shortcuts type nothing
	await cmd("Input.dispatchKeyEvent", { type: withText ? "keyDown" : "rawKeyDown", modifiers, ...info, ...(withText ? { text: typed } : {}) });
	if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
	await cmd("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...info });
}

const keys = defineTool({
	name: "page_keys",
	// Input must land in order, and the effect report must not see another call's effects.
	executionMode: "sequential",
	description:
		"Real (trusted) keyboard input to the focused element of the attached tab: keydown/keypress/input/keyup like a person typing. " +
		'Pass text to type it, and/or key for one key or shortcut: "Enter", "Escape", "ArrowUp", "F5", "w", "Ctrl+A", "Shift+Tab". Focus a field first with page_mouse.',
	parameters: Type.Object({
		text: Type.Optional(Type.String({ description: "Typed character by character; \\n presses Enter" })),
		key: Type.Optional(Type.String()),
		holdMs: Type.Optional(Type.Number({ description: "Hold the key down this long, e.g. for movement in games" })),
	}),
	execute: async ({ text: typed, key, holdMs }) => {
		if (typed === undefined && key === undefined) return { ...text("Pass text or key"), isError: true };
		for (const ch of typed ?? "") await pressKey(ch === "\n" ? "Enter" : ch === "+" ? "+" : ch);
		if (key !== undefined) await pressKey(key, holdMs);
		return text(`Sent ${[typed !== undefined && `text (${[...typed].length} chars)`, key].filter(Boolean).join(" and ")}`);
	},
});

const consoleLogs = defineTool({
	name: "console_logs",
	description:
		"Console messages, uncaught exceptions and browser log entries of the attached tab, captured since the debugger attached (first tool call on the tab). Reload the page to capture startup logs.",
	parameters: Type.Object({
		limit: Type.Optional(Type.Number({ description: "Newest N entries, default 100" })),
		clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading" })),
		filter: Type.Optional(Type.String({ description: "Case-insensitive substring the line must contain" })),
		level: Type.Optional(Type.String({ description: 'Only this type, e.g. "error", "warning", "uncaught", "log"' })),
	}),
	execute: async ({ limit = 100, clear, filter, level }) => {
		const log = logs.get(await tab())!;
		const lines = log.console
			.filter((l) => (!level || l.startsWith(`[${level}`)) && (!filter || l.toLowerCase().includes(filter.toLowerCase())))
			.slice(-limit);
		if (clear) log.console.length = 0;
		return text(lines.join("\n") || "(no console messages captured yet)");
	},
});

const network = defineTool({
	name: "network_requests",
	description:
		"Network requests of the attached tab captured since the debugger attached: id, method, status, type, url. " +
		'Get a response body with cdp {method:"Network.getResponseBody", params:{requestId}}.',
	parameters: Type.Object({
		filter: Type.Optional(Type.String({ description: "Substring the URL must contain" })),
		limit: Type.Optional(Type.Number({ description: "Newest N requests, default 50" })),
		withRequestBody: Type.Optional(Type.Boolean()),
	}),
	execute: async ({ filter, limit = 50, withRequestBody }) => {
		const reqs = [...logs.get(await tab())!.network.values()].filter((r) => !filter || r.url.includes(filter));
		const lines = reqs.slice(-limit).map((r) =>
			[r.id, r.method, r.error ?? r.status ?? "pending", r.type, r.url, withRequestBody && r.reqBody ? `\n  body: ${r.reqBody}` : ""].join(" "),
		);
		return text(lines.join("\n") || "(no requests captured yet)");
	},
});

const cdp = defineTool({
	name: "cdp",
	description:
		"Send any Chrome DevTools Protocol command to the attached tab and get its JSON result. Examples: Page.reload, Page.navigate {url}, " +
		"Network.getResponseBody {requestId}, Network.getCookies, Network.setCookie, Storage.clearDataForOrigin, Emulation.setDeviceMetricsOverride, " +
		"Page.addScriptToEvaluateOnNewDocument {source}, DOM.*, CSS.*, Debugger.*. params is a JSON object.",
	parameters: Type.Object({ method: Type.String(), params: Type.Optional(Type.Any()) }),
	// codemode scripts get the parsed result object.
	structuredOutputSchema: Type.Any(),
	execute: async ({ method, params }) => {
		// Models often send params as a JSON string or null; chrome.debugger rejects both ("No matching signature").
		if (typeof params === "string") {
			try {
				params = params.trim() ? JSON.parse(params) : undefined;
			} catch {
				return { ...text(`params must be a JSON object, got unparseable string: ${params.slice(0, 200)}`), isError: true };
			}
		}
		if (params === null) params = undefined;
		if (params !== undefined && (typeof params !== "object" || Array.isArray(params))) {
			return { ...text(`params must be a JSON object, got ${Array.isArray(params) ? "an array" : typeof params}`), isError: true };
		}
		const result = await cmd(method, params);
		return { ...text(JSON.stringify(result, null, 1)), structuredOutput: result ?? null };
	},
});

const wait = defineTool({
	name: "page_wait",
	description:
		"Wait until a JavaScript expression is truthy in the page (polled), or just sleep for ms. Use it instead of screenshot polling, " +
		"e.g. until the app has booted; codemode scripts have no setTimeout, so use this to sleep there too.",
	parameters: Type.Object({
		until: Type.Optional(Type.String({ description: "Expression polled in the page; errors count as false" })),
		ms: Type.Optional(Type.Number({ description: "Without until: sleep this long" })),
		timeoutMs: Type.Optional(Type.Number({ description: "Default 15000" })),
		intervalMs: Type.Optional(Type.Number({ description: "Default 250" })),
	}),
	structuredOutputSchema: Type.Object({ ok: Type.Boolean(), elapsedMs: Type.Number(), value: Type.Any() }),
	execute: async ({ until, ms, timeoutMs = 15_000, intervalMs = 250 }) => {
		const start = Date.now();
		const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
		if (until === undefined) {
			await sleep(ms ?? 0);
			return { ...text(`Slept ${Date.now() - start} ms`), structuredOutput: { ok: true, elapsedMs: Date.now() - start, value: null } };
		}
		let last: JsonValue = null;
		while (Date.now() - start < timeoutMs) {
			const r = await evaluate(until);
			last = r.exceptionDetails ? `error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}` : (r.result.value ?? null);
			if (!r.exceptionDetails && r.result.value) {
				const elapsedMs = Date.now() - start;
				return { ...text(`True after ${elapsedMs} ms: ${JSON.stringify(last)}`.slice(0, 2000)), structuredOutput: { ok: true, elapsedMs, value: last } };
			}
			await sleep(intervalMs);
		}
		const elapsedMs = Date.now() - start;
		return { ...text(`Timed out after ${elapsedMs} ms; last value: ${JSON.stringify(last)}`.slice(0, 2000)), isError: true, structuredOutput: { ok: false, elapsedMs, value: last } };
	},
});

// ponytail: names live in panel memory and die with the debugger session; Chrome drops the scripts then too
const preloads = new Map<number, Map<string, string>>();
const preloadsOf = (tabId: number) => {
	const mine = preloads.get(tabId) ?? new Map<string, string>();
	preloads.set(tabId, mine);
	return mine;
};
async function setPreload(tabId: number, name: string, source: string | undefined) {
	const mine = preloadsOf(tabId);
	const old = mine.get(name);
	if (old) await cmd("Page.removeScriptToEvaluateOnNewDocument", { identifier: old });
	mine.delete(name);
	if (source === undefined) return;
	const { identifier } = await cmd("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true });
	mine.set(name, identifier);
}
const preload = defineTool({
	name: "page_preload",
	description:
		"Named scripts that run in every new document of the attached tab before its own scripts (also right away in the current one): " +
		"hooks, helper globals, fetch overrides. They survive reloads, so state you need after a reload belongs here. " +
		"add replaces a script of the same name; list shows what is live. A broken hook can break the app's boot: remove it and reload.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("list")]),
		name: Type.Optional(Type.String()),
		source: Type.Optional(Type.String({ description: "For add: JavaScript" })),
	}),
	execute: async ({ action, name, source }) => {
		const id = await tab();
		if (action !== "list") {
			if (!name) return { ...text("Pass name"), isError: true };
			if (action === "add" && !source) return { ...text("Pass source"), isError: true };
			await setPreload(id, name, action === "add" ? source : undefined);
		}
		return text(`Preloads on this tab: ${[...preloadsOf(id).keys()].join(", ") || "none"}`);
	},
});

// Page-side wrapper: records each call's arguments and its JS + wasm stack, then calls the original.
// wasm frames show up only when wasm reaches the hooked function through a JS import (wasm-bindgen glue).
const hookSource = (target: string) => `(() => {
	const hooks = (globalThis.__piHooks ??= {});
	const target = ${JSON.stringify(target)};
	if (hooks[target]) return;
	const path = target.split("."), name = path.pop();
	const owner = path.reduce((o, p) => o?.[p], globalThis);
	const orig = owner?.[name];
	if (typeof orig !== "function") return;
	const cut = (s) => (s.length > 300 ? s.slice(0, 300) + "…" : s);
	const show = (a) => {
		try {
			if (typeof a === "string") return JSON.stringify(cut(a));
			if (a instanceof ArrayBuffer || ArrayBuffer.isView(a)) return a.constructor.name + "(" + a.byteLength + " bytes)";
			if (typeof a === "function") return "function " + (a.name || "anonymous");
			const s = JSON.stringify(a);
			return s === undefined ? String(a) : cut(s);
		} catch { return Object.prototype.toString.call(a); }
	};
	const wrapped = function (...args) {
		const limit = Error.stackTraceLimit;
		Error.stackTraceLimit = 50;
		const stack = (new Error().stack || "").split("\\n").slice(2).map((l) => l.trim());
		Error.stackTraceLimit = limit;
		try { globalThis.__piHook?.(JSON.stringify({ t: Date.now(), target, args: args.map(show), stack })); } catch {}
		return new.target ? Reflect.construct(orig, args, new.target) : orig.apply(this, args);
	};
	hooks[target] = { owner, name, orig };
	Object.defineProperty(owner, name, { value: wrapped, writable: true, configurable: true });
})();`;

const hook = defineTool({
	name: "page_hook",
	description:
		"Wrap a page function to record every call with its arguments and full call stack, including wasm frames (wasm-function[N]:0xOFFSET) when wasm calls it through a JS import. " +
		'target is a dotted path from globalThis: "Storage.prototype.setItem", "WebAssembly.instantiate", "crypto.subtle.encrypt", "app.save". ' +
		"Hooks are reinstalled on every new document, so they catch calls during boot and survive reloads, and recorded calls are kept across reloads. " +
		"Use action calls to read them (newest last).",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("list"), Type.Literal("calls")]),
		target: Type.Optional(Type.String()),
		filter: Type.Optional(Type.String({ description: "For calls: substring of target, arguments or stack" })),
		limit: Type.Optional(Type.Number({ description: "For calls: newest N, default 10" })),
		stackLines: Type.Optional(Type.Number({ description: "For calls: stack frames per call, default 20" })),
		clear: Type.Optional(Type.Boolean({ description: "For calls: clear the record after reading" })),
	}),
	// codemode scripts get the call records: [{ t, target, args, stack }].
	structuredOutputSchema: Type.Any(),
	execute: async ({ action, target, filter, limit = 10, stackLines = 20, clear }) => {
		const id = await tab();
		const hooked = () => [...preloadsOf(id).keys()].filter((k) => k.startsWith("hook:")).map((k) => k.slice(5));
		if (action === "calls") {
			const log = logs.get(id)!;
			const calls = log.hooks
				.filter((c) => !filter || [c.target, ...c.args, ...c.stack].some((s) => s.includes(filter)))
				.slice(-limit)
				.map((c) => ({ ...c, stack: c.stack.slice(0, stackLines) }));
			if (clear) log.hooks.length = 0;
			const body = calls
				.map((c) => `${new Date(c.t).toISOString().slice(11, 23)} ${c.target}(${c.args.join(", ")})\n${c.stack.map((l) => `    ${l}`).join("\n")}`)
				.join("\n\n");
			return { ...text(body || `(no calls recorded; hooks: ${hooked().join(", ") || "none"})`), structuredOutput: calls };
		}
		if (action !== "list") {
			if (!target) return { ...text("Pass target"), isError: true };
			await setPreload(id, `hook:${target}`, action === "add" ? hookSource(target) : undefined);
			if (action === "remove") {
				await evaluate(`(() => { const h = globalThis.__piHooks?.[${JSON.stringify(target)}]; if (!h) return;
					Object.defineProperty(h.owner, h.name, { value: h.orig, writable: true, configurable: true }); delete globalThis.__piHooks[${JSON.stringify(target)}]; })()`);
			} else if (!(await evaluate(`!!globalThis.__piHooks?.[${JSON.stringify(target)}]`)).result.value) {
				return {
					...text(`${target} is not a function in the current page, so nothing is hooked now; new documents get the hook if it exists when they start.`),
					structuredOutput: { hooks: hooked() },
				};
			}
		}
		return { ...text(`Hooked: ${hooked().join(", ") || "none"}`), structuredOutput: { hooks: hooked() } };
	},
});

/** Defined functions of a wasm script: name, module index when Chrome prints one, and the header's code offset. */
async function wasmFunctions(scriptId: string) {
	// ponytail: only the first disassembly chunk; modules with >1000-line headers need an offset instead
	const d = await cmd("Debugger.disassembleWasmModule", { scriptId });
	const fns: { name: string; index?: number; offset: number }[] = [];
	d.chunk.lines.forEach((line: string, i: number) => {
		if (!/^\s*\(func\b/.test(line) || line.includes("(import")) return;
		const name = /\(func \$([^\s()]+)/.exec(line)?.[1];
		const index = /\(;(\d+);\)/.exec(line)?.[1];
		fns.push({ name: name ?? "?", index: index === undefined ? undefined : Number(index), offset: d.chunk.bytecodeOffsets[i] });
	});
	return fns;
}

const breakpoint = defineTool({
	name: "wasm_breakpoint",
	description:
		"Breakpoint inside a WebAssembly function. When it runs, records the call stack - including wasm calling wasm directly, which page_hook cannot see - and the function's locals, then resumes the page. " +
		"Set it by code offset (the 0x... in a wasm-function[N]:0x... stack frame), by function name, or by module function index. " +
		"A paused page blocks every other tool, so captures are automatic: trigger the code, then read action hits.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("list"), Type.Literal("hits")]),
		target: Type.Optional(Type.String({ description: "Substring of the wasm module URL; default the most recently loaded module" })),
		fn: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: 'Function name ("run", "$run") or module function index' })),
		offset: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Byte offset in the wasm code section, decimal or 0x hex, e.g. 0x2f from a stack frame" })),
		name: Type.Optional(Type.String({ description: "Label for this breakpoint (and for hits: only pauses from it); default the function name or offset" })),
		filter: Type.Optional(Type.String({ description: "For hits: substring of a frame, URL or local" })),
		limit: Type.Optional(Type.Number({ description: "For hits: newest N pauses, default 10" })),
		clear: Type.Optional(Type.Boolean({ description: "For hits: clear the record after reading" })),
	}),
	// codemode scripts get the pause records: [{ t, reason, frames }].
	structuredOutputSchema: Type.Any(),
	execute: async ({ action, target, fn, offset, name, filter, limit = 10, clear }) => {
		const id = await tab();
		const log = logs.get(id)!;
		if (!log.dbg) {
			// Chrome only reports wasm modules once the Debugger domain is on; enabled lazily, on first use.
			await cmd("Debugger.enable");
			log.dbg = true;
		}
		const active = () => [...log.bps].map(([n, b]) => `${n} @0x${b.offset.toString(16)}`).join(", ") || "none";
		if (action === "hits") {
			const hits = log.pauses
				.filter((h) => (!name || h.bps.includes(name)) && (!filter || h.frames.some((f) => [f.fn, f.url ?? "", f.locals ?? ""].some((s) => s.includes(filter)))))
				.slice(-limit);
			if (clear) log.pauses.length = 0;
			const body = hits
				.map(
					(h) =>
						`${new Date(h.t).toISOString().slice(11, 23)} ${h.reason}${h.bps.length ? ` [${h.bps.join(", ")}]` : ""}\n` +
						h.frames.map((f) => (f.wasm ? `  ${f.fn}  ${f.url}  0x${f.offset!.toString(16)}${f.locals ? `  local ${f.locals}` : ""}` : `  ${f.fn}  (${f.url ?? "?"}:${f.line})`)).join("\n"),
				)
				.join("\n\n");
			return { ...text(body || `(no pauses recorded; breakpoints: ${active()})`), structuredOutput: hits };
		}
		if (action === "remove") {
			const gone = name ? [name] : [...log.bps.keys()];
			for (const n of gone) {
				const bp = log.bps.get(n);
				if (bp) await cmd("Debugger.removeBreakpoint", { breakpointId: bp.breakpointId }).catch(() => {});
				log.bps.delete(n);
			}
			return { ...text(`Removed: ${gone.join(", ") || "none"}; breakpoints: ${active()}`), structuredOutput: { removed: gone } as JsonValue };
		}
		if (action === "list") return { ...text(`Breakpoints: ${active()}`), structuredOutput: [...log.bps.keys()] };

		// add: scripts are reported asynchronously after Debugger.enable.
		let script;
		for (let i = 0; !(script = (target ? [...log.wasmScripts.values()].filter((s) => s.url.includes(target)) : [...log.wasmScripts.values()]).at(-1)) && i < 10; i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		if (!script) {
			const all = [...log.wasmScripts.values()];
			// Chrome reports wasm under its internal URL (wasm://wasm/<hash>), never the file it was fetched from.
			if (target && all.length === 1) {
				script = all[0];
			} else {
				return {
					...text(`No WebAssembly module matching ${target ?? "(none loaded)"}. Modules in this tab: ${all.map((s) => s.url).join(", ") || "none"}`),
					isError: true,
				};
			}
		}
		let off = offset === undefined ? undefined : Number(offset);
		let label = name;
		if (off === undefined) {
			if (fn === undefined) return { ...text("Pass offset (from a stack frame) or fn"), isError: true };
			const fns = await wasmFunctions(script.id);
			const hit = typeof fn === "number" ? fns.find((f) => f.index === fn) : fns.find((f) => f.name === String(fn).replace(/^\$/, ""));
			if (!hit) {
				return { ...text(`No function ${fn} in ${script.url}. Defined functions: ${fns.map((f) => `${f.name}@0x${f.offset.toString(16)}`).slice(0, 60).join(", ")}`), isError: true };
			}
			off = hit.offset;
			label ??= `$${hit.name}`;
		}
		label ??= `0x${off.toString(16)}`;
		const old = log.bps.get(label);
		if (old) await cmd("Debugger.removeBreakpoint", { breakpointId: old.breakpointId }).catch(() => {});
		const { breakpointId, actualLocation } = await cmd("Debugger.setBreakpoint", { location: { scriptId: script.id, lineNumber: 0, columnNumber: off } });
		log.bps.set(label, { breakpointId, scriptId: script.id, offset: actualLocation.columnNumber });
		return {
			...text(`Breakpoint ${label} on ${script.url} at 0x${actualLocation.columnNumber.toString(16)}. Trigger it, then action hits.`),
			structuredOutput: { name: label, offset: actualLocation.columnNumber, breakpoints: [...log.bps.keys()] },
		};
	},
});


/** The running wasm module: bytes from Chrome's copy, parsed once per tab. */
async function wasmModule() {
	const id = await tab();
	const log = logs.get(id)!;
	if (!log.dbg) {
		await cmd("Debugger.enable");
		log.dbg = true;
	}
	let script;
	for (let i = 0; !(script = [...log.wasmScripts.values()].at(-1)) && i < 10; i++) await new Promise((r) => setTimeout(r, 100));
	if (!script) throw new Error("No WebAssembly module in this tab; load it, then retry.");
	if (log.module?.scriptId !== script.id) {
		const { bytecode } = await cmd("Debugger.getScriptSource", { scriptId: script.id });
		if (!bytecode) throw new Error(`Chrome returned no bytecode for ${script.url}`);
		log.module = { scriptId: script.id, parsed: parseWasm(bytesFromBase64(bytecode)) };
	}
	return { log, m: log.module.parsed, url: script.url };
}

const pickFn = (m: WasmModule, fn?: string | number) => {
	if (fn === undefined) return undefined;
	if (typeof fn === "number") return m.funcs.find((f) => f.index === fn);
	const want = String(fn).replace(/^\$/, "");
	return m.funcs.find((f) => f.name === want || f.name?.endsWith(`.${want}`));
};

const wasm = defineTool({
	name: "wasm",
	description:
		"Read and rewrite the WebAssembly module loaded in the attached tab. actions: functions (index, name, signature, body range), disasm (fn, or offset+size), callers (who calls fn), xrefs (who mentions an address), " +
		"patch (fn + hex, body-size preserving, padded with nops), addExport (fn + name, e.g. expose an internal open()), apply (serve the patched module for a URL pattern). " +
		"After patch or addExport, call apply with a pattern such as *game*.wasm, then cdp Page.reload to run it. Bytes come from Chrome's live copy, so a 100 MB module is not downloaded again.",
	parameters: Type.Object({
		action: Type.Union([
			Type.Literal("functions"),
			Type.Literal("disasm"),
			Type.Literal("callers"),
			Type.Literal("xrefs"),
			Type.Literal("patch"),
			Type.Literal("addExport"),
			Type.Literal("apply"),
		]),
		fn: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Function index or name" })),
		offset: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "For disasm: byte offset, decimal or 0x hex, instead of fn" })),
		size: Type.Optional(Type.Number({ description: "For disasm with offset: byte range" })),
		addr: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "For xrefs: data address, decimal or 0x hex" })),
		name: Type.Optional(Type.String({ description: "For addExport: the new export name" })),
		hex: Type.Optional(Type.String({ description: "For patch: instruction bytes as hex, e.g. 200041056c (local.get 0; i32.const 5; i32.mul)" })),
		filter: Type.Optional(Type.String({ description: "For functions: substring of the name" })),
		limit: Type.Optional(Type.Number({ description: "Max lines, default 40 for functions and 300 for disasm/callers/xrefs" })),
		pattern: Type.Optional(Type.String({ description: 'For apply: URL pattern to serve patched bytes for, default "*wasm*"' })),
	}),
	structuredOutputSchema: Type.Any(),
	execute: async ({ action, fn, offset, size, addr, name, hex, filter, limit, pattern }): Promise<ToolExecutionResult<JsonValue>> => {
		if (action === "apply") {
			const { log } = await wasmModule();
			if (!log.patched) return { ...text("Nothing patched yet: run patch or addExport first."), isError: true };
			await cmd("Fetch.enable", { patterns: [{ urlPattern: pattern ?? "*wasm*", requestStage: "Response" }] });
			return {
				...text(`Serving ${log.patched.label} (${log.patched.bytes.length} bytes) for responses matching ${pattern ?? "*wasm*"}. Reload the page (cdp Page.reload) to run it.`),
				structuredOutput: { label: log.patched.label, bytes: log.patched.bytes.length },
			};
		}
		const { log, m, url } = await wasmModule();
		if (action === "functions") {
			const rows = [
				...m.imports.map((i) => `[${i.index}] ${i.name} (import)`),
				...m.funcs.map(
					(f) =>
						`[${f.index}] ${f.name ? `$${f.name}` : "(unnamed)"} ${fmtType(f)}  0x${f.bodyStart.toString(16)}-0x${f.bodyEnd.toString(16)} (${f.size} B)` +
						m.exports.filter((e) => e.kind === 0 && e.index === f.index).map((e) => `  export "${e.name}"`).join(""),
				),
			].filter((r) => !filter || r.toLowerCase().includes(filter.toLowerCase()));
			const max = limit ?? 40;
			return {
				...text(`${rows.length} functions in ${url}${filter ? ` matching "${filter}"` : ""}:
${rows.slice(0, max).join("\n")}${rows.length > max ? `\n… ${rows.length - max} more; narrow with filter` : ""}`),
				structuredOutput: m.funcs.map((f) => ({ index: f.index, name: f.name ?? null, type: fmtType(f), bodyStart: f.bodyStart, bodyEnd: f.bodyEnd })),
			};
		}
		if (action === "callers" || action === "xrefs") {
			let found;
			let label;
			if (action === "callers") {
				const f = pickFn(m, fn);
				if (!f) return { ...text(`No function ${fn}; see action functions`), isError: true };
				found = callers(m, f.index).hits;
				label = `callers of $${f.name ?? `func${f.index}`}`;
			} else {
				if (addr === undefined) return { ...text("Pass addr"), isError: true };
				const a = Number(addr);
				found = xrefs(m, a).hits;
				label = `references to 0x${a.toString(16)}`;
			}
			const max = limit ?? 300;
			const body = found.slice(0, max).map((h) => `  $${h.fn} @0x${h.offset.toString(16)}: ${h.text}${"kind" in h ? ` (${h.kind})` : ""}`).join("\n");
			return { ...text(`${found.length} ${label}:\n${body}${found.length > max ? `\n… ${found.length - max} more` : ""}`), structuredOutput: found };
		}
		if (action === "disasm") {
			let f: WasmFunc | undefined = pickFn(m, fn);
			if (!f && offset !== undefined) {
				const start = Number(offset);
				f = { index: -1, typeIdx: -1, name: "range", params: [], results: [], bodyStart: start, bodyEnd: start + (size ?? 64), size: size ?? 64 };
			}
			if (!f) return { ...text("Pass fn, or offset and size"), isError: true };
			let lines: string[];
			try {
				lines = disasm(m, f);
			} catch (e) {
				return { ...text(`${e instanceof Error ? e.message : e}; this body uses an opcode the decoder does not know`), isError: true };
			}
			const max = limit ?? 300;
			return {
				...text(`$${f.name ?? `func${f.index}`} ${fmtType(f)} @0x${f.bodyStart.toString(16)}:\n${lines.slice(0, max).join("\n")}${lines.length > max ? `\n… ${lines.length - max} more lines` : ""}`),
				structuredOutput: lines,
			};
		}
		const f = pickFn(m, fn);
		if (!f) return { ...text(`No function ${fn}; see action functions`), isError: true };
		if (action === "patch") {
			if (!hex) return { ...text("Pass hex bytes"), isError: true };
			const clean = hex.replace(/[^0-9a-f]/gi, "");
			if (clean.length % 2) return { ...text("hex must have an even number of digits"), isError: true };
			const bytes = new Uint8Array(clean.match(/../g)!.map((h) => parseInt(h, 16)));
			const out = patchBody(m.bytes, f.index, bytes);
			log.patched = { bytes: out.bytes, label: `patched $${f.name ?? `func${f.index}`}` };
			// Later reads describe the module being built, not the one still running.
			log.module = { scriptId: log.module!.scriptId, parsed: parseWasm(out.bytes) };
			return {
				...text(`Patched ${bytes.length} bytes into $${f.name ?? `func${f.index}`} (${out.room} available, padded with nops). disasm now shows it. Call apply, then cdp Page.reload.`),
				structuredOutput: { fn: f.index, bytes: bytes.length, room: out.room },
			};
		}
		if (!name) return { ...text("Pass name for addExport"), isError: true };
		const out = addExport(m.bytes, f.index, name);
		log.patched = { bytes: out, label: `export ${name} -> $${f.name ?? `func${f.index}`}` };
		log.module = { scriptId: log.module!.scriptId, parsed: parseWasm(out) };
		return {
			...text(`Added export "${name}" for $${f.name ?? `func${f.index}`} (module ${m.bytes.length} -> ${out.length} bytes). Call apply, then cdp Page.reload.`),
			structuredOutput: { export: name, fn: f.index, bytes: out.length },
		};
	},
});

export const PageTools = defineExtension({
	name: "page",
	tools: [pageEval, screenshot, mouse, keys, wait, preload, hook, breakpoint, wasm, consoleLogs, network, cdp],
});
