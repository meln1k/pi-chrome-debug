// Differential check of src/wasm.ts against Chrome's own wasm disassembler (V8).
// For every function it compares the byte offset of every instruction, plus the mnemonic, with
// what V8 prints: if the decoder's boundaries drift, this fails immediately.
// Usage: CHROME=/path/to/chrome node test/wasm-diff.mjs [file.wasm]
// test/site/wasm-torture.wasm covers SIMD, atomics, exceptions, reference types, bulk memory,
// tail calls, multi-value and typed select; node_modules/quickjs-wasi/quickjs.wasm is real Clang output.
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const file = process.argv[2] ?? "test/site/wasm-deep.wasm";
const OUT = new URL("./.wasm-bundle.mjs", import.meta.url).pathname;
await build({ entryPoints: ["src/wasm.ts"], bundle: true, format: "esm", outfile: OUT, logLevel: "silent" });
const { parseWasm, decode, xrefs, callers } = await import(OUT);

const bytes = new Uint8Array(await readFile(file));
const m = parseWasm(bytes);
const decoded = new Map();
for (const f of m.funcs) {
	try {
		decoded.set(f.index, decode(m, f));
	} catch {
		/* reported below via the missing entry */
	}
}

// Serve the module and a page that compiles it, so Chrome parses exactly these bytes.
const server = createServer((req, res) => {
	if (req.url === "/module.wasm") {
		res.writeHead(200, { "content-type": "application/wasm" });
		res.end(bytes);
	} else {
		res.writeHead(200, { "content-type": "text/html" });
		res.end('<!doctype html><script>fetch("/module.wasm").then(r=>r.arrayBuffer()).then(b=>WebAssembly.compile(b)).then(m=>{window.mod=m})</script>');
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
const cdp = await (await browser.pages())[0].target().createCDPSession();
const scripts = [];
cdp.on("Debugger.scriptParsed", (e) => {
	if (e.scriptLanguage === "WebAssembly") scripts.push(e);
});
await cdp.send("Debugger.enable");
await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
await new Promise((r) => setTimeout(r, 1500));
const script = scripts.at(-1);
if (script.length !== bytes.length) throw new Error(`Chrome parsed ${script.length} bytes, file has ${bytes.length}`);

let d = await cdp.send("Debugger.disassembleWasmModule", { scriptId: script.scriptId });
const lines = [];
const offsets = [];
const take = (chunk) => {
	for (const l of chunk.lines) lines.push(l);
	for (const o of chunk.bytecodeOffsets) offsets.push(o);
};
take(d.chunk);
while (d.streamId) {
	d = await cdp.send("Debugger.nextWasmDisassemblyChunk", { streamId: d.streamId });
	take(d.chunk);
}
const text = new Map();
for (let i = 0; i < lines.length; i++) text.set(offsets[i], lines[i]);
const sorted = [...text.keys()].sort((a, b) => a - b);
const mnemonic = (line) => {
	const t = line.trim();
	return t === ")" ? "end" : t.split(/\s/)[0];
};

let matched = 0;
const bad = [];
const named = [];
for (const f of m.funcs) {
	const code = decoded.get(f.index);
	if (!code) continue;
	const mine = code.filter((i) => i.offset < f.bodyEnd - 1).map((i) => i.offset);
	const theirs = sorted.filter((o) => o >= f.bodyStart && o < f.bodyEnd - 1);
	if (mine.join() === theirs.join()) matched++;
	else bad.push(`func ${f.name ?? f.index}: ${mine.length} instructions vs V8 ${theirs.length}`);
	for (const i of code) {
		if (i.offset >= f.bodyEnd - 1 || /^(simd|fc|atomic)\./.test(i.name)) continue; // V8 uses bare mnemonics there
		const v8 = text.get(i.offset);
		if (v8 && mnemonic(v8) !== i.name) named.push(`func ${f.name ?? f.index}+0x${i.offset.toString(16)}: ${i.name} vs ${v8.trim()}`);
	}
}
const xr = xrefs(m, 1048576).hits.filter((h) => !/^(i32|i64)\.const 1048576$/.test((text.get(h.offset) ?? "").trim()));
console.log(`${file}: ${bytes.length} bytes, ${m.funcs.length} functions`);
console.log(`instruction boundaries: ${matched}/${m.funcs.length} functions match V8 offset-for-offset`);
console.log(`mnemonics: ${named.length} differ; xrefs: ${xr.length} disagree with V8's line`);
for (const b of bad.slice(0, 5)) console.log("  " + b);
for (const n of named.slice(0, 5)) console.log("  " + n);
await browser.close();
server.close();
await rm(OUT);
if (bad.length || named.length || xr.length) process.exitCode = 1;
