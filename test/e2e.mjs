// E2E: serve test/site on :8765, then CHROME=/path/to/chrome PROVIDER=openrouter|opencode-go OPENROUTER_API_KEY=… OPENCODE_API_KEY=… PROFILE=/tmp/p node test/e2e.mjs [restore]
import puppeteer from "puppeteer-core";

const EXT = new URL("../dist", import.meta.url).pathname;
const SITE = "http://localhost:8765/";
const ART = process.env.ART ?? "/tmp";
const browser = await puppeteer.launch({
	executablePath: process.env.CHROME,
	headless: true,
	userDataDir: process.env.PROFILE,
	pipe: true,
	enableExtensions: [EXT],
	args: ["--no-sandbox", "--window-size=1400,900"],
	defaultViewport: null,
});
const page = (await browser.pages())[0];
await page.goto(SITE);

const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker")).worker();
await sw.evaluate(async () => { while (!(await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick) await new Promise((r) => setTimeout(r, 50)); });
const [ext] = (await browser.extensions()).values();
await page.triggerExtensionAction(ext);
const panelTarget = await browser.waitForTarget((t) => t.url().endsWith("/panel.html"));
const panel = await panelTarget.asPage();
panel.on("console", (m) => console.log("panel console:", m.text()));
panel.on("pageerror", (e) => console.log("panel error:", e.message));
console.log("panel open");
await panel.waitForSelector("body[data-ready]");
const PROVIDER = process.env.PROVIDER ?? "openrouter";
const busy = () => panel.evaluate(() => document.body.hasAttribute("data-busy"));
if (process.argv[2] !== "restore") {
	// First run with no key: the settings dialog opens by itself.
	await panel.waitForSelector("#settings[open]");
	await panel.screenshot({ path: `${ART}/settings.png` });
	await panel.select("#provider", PROVIDER);
	await panel.type("#key", PROVIDER === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.OPENCODE_API_KEY);
	await panel.$eval("#key", (e) => e.dispatchEvent(new Event("change")));
	await panel.click("#done");
	await panel.screenshot({ path: `${ART}/empty.png` });
}
if (process.env.THINKING) {
	await panel.select("#thinking", process.env.THINKING);
}
console.log("thinking:", await panel.$eval("#thinking", (e) => e.value));
console.log("provider:", await panel.$eval("#provider", (e) => e.value), "model:", await panel.$eval("#model", (e) => e.value), "models:", await panel.$$eval("#model option", (o) => o.length));

async function ask(prompt) {
	const before = await panel.$$eval("#log > *", (e) => e.length);
	await panel.click("#input");
	await panel.type("#input", prompt);
	await panel.keyboard.press("Enter");
	await panel.waitForFunction(() => document.body.hasAttribute("data-busy"), { timeout: 20000 });
	await panel.waitForFunction(() => !document.body.hasAttribute("data-busy"), { timeout: 240000 });
	const items = await panel.$$eval("#log > *", (e) => e.map((x) => `${x.className}: ${x.textContent.slice(0, 300)}`));
	console.log(`\n### ${prompt}\n${items.slice(before).join("\n")}`);
}

const step = process.argv[2] ?? "all";
if (step === "all") {
	await ask("Why is the cart total wrong? Find the root cause in the page's JS state and fix it live on the page so the total renders correctly.");
	console.log("PAGE total:", await page.$eval("#total", (e) => e.textContent));
	await ask("Reload the page, then click the Checkout button, and tell me every console error and every failed network request.");
	await ask("Change the h1 heading text to 'Debugged by Pi' and set localStorage key theme to 'dark'.");
	console.log("PAGE h1:", await page.$eval("#title", (e) => e.textContent), "theme:", await page.evaluate(() => localStorage.theme));
	await ask("Take a screenshot of the page and describe what you see in one sentence.");
	console.log("thinking traces:", await panel.$$eval("#log details.thinking", (e) => e.length));
	await panel.screenshot({ path: `${ART}/panel.png` });
	// New chat, one message, then switch back to the first chat through the list.
	await panel.click("#new");
	// the switch to the new conversation is async; typing before it lands sends to the previous chat.
	await panel.waitForFunction(() => document.querySelector("#log > .empty"), { timeout: 10000 });
	console.log("new chat empty:", await panel.$eval("#log", (e) => e.textContent));
	await ask("What is the page title? Answer in one word.");
	const opts = await panel.$$eval("#chats option", (o) => o.map((x) => [x.value, x.textContent]));
	console.log("chats:", JSON.stringify(opts));
	await panel.screenshot({ path: `${ART}/chat2.png` });
	await panel.select("#chats", opts[1][0]);
	await panel.waitForFunction(() => document.querySelectorAll("#log > .user").length === 4, { timeout: 10000 });
	console.log("switched back: 4 user messages");
	// wasm breakpoints: wasm calling wasm, which page_hook cannot see.
	await page.goto("http://localhost:8765/wasm-deep.html");
	await ask("Set a wasm_breakpoint on the $inner function, click the Run button, and report the wasm call stack it records.");
	const bp = await panel.$eval("#log", (e) => e.textContent);
	const result = await page.$eval("#result", (e) => e.textContent);
	console.log("PAGE result after breakpoint:", result, "| recorded $inner:", bp.includes("$inner"), "$outer:", bp.includes("$outer"));
	if (!bp.includes("$inner") || !bp.includes("$outer") || result !== "12") throw new Error("wasm breakpoint step failed");
	// wasm toolkit: expose an internal function, serve the patched module, and call the new export.
	await page.goto("http://localhost:8765/wasm-deep.html");
	await ask("Use the wasm tool to add an export named secret for the $secret function, apply it for *.wasm, then reload the page and confirm window.wasm.exports.secret(7).");
	await page.waitForFunction(() => window.wasm?.exports?.secret, { timeout: 8000 });
	const secret = await page.evaluate(() => window.wasm.exports.secret(7));
	console.log("PAGE secret(7) after patched reload:", secret);
	if (secret !== 21) throw new Error("wasm addExport/apply step failed");
} else {
	// persistence check: transcript reloaded from IndexedDB
	const items = await panel.$$eval("#log > *", (e) => e.map((x) => x.className));
	console.log("uncaught TypeError captured:", await panel.$eval("#log", (e) => /\[uncaught\] TypeError/.test(e.textContent)));
	console.log("RESTORED entries:", items.length, items.filter((c) => c === "user").length, "user messages; chats:", await panel.$$eval("#chats option", (o) => o.length));
	await panel.screenshot({ path: `${ART}/panel-restored.png` });
}
await browser.close();
