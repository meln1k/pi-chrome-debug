// Checks src/wasm.ts against a known module: parse, disassemble, xrefs, callers, patch, addExport.
// Run with `node test/wasm.test.mjs`; it bundles the TypeScript first, so no build step is needed.
import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";

const OUT = new URL("./.wasm-bundle.mjs", import.meta.url).pathname;
await build({ entryPoints: ["src/wasm.ts"], bundle: true, format: "esm", outfile: OUT, logLevel: "silent" });
const { parseWasm, disasm, callers, xrefs, patchBody, addExport, fmtType } = await import(OUT);

const bytes = new Uint8Array(await readFile("test/site/wasm-deep.wasm"));
const m = parseWasm(bytes);

// Imports take the low indices; 3 defined functions follow.
assert.deepEqual(
	m.funcs.map((f) => [f.index, f.name, fmtType(f)]),
	[
		[1, "secret", "(i32) -> (i32)"],
		[2, "inner", "(i32) -> (i32)"],
		[3, "outer", "(i32) -> (i32)"],
	],
);
assert.deepEqual(m.exports.map((e) => e.name).sort(), ["inner", "run"]);

const inner = m.funcs.find((f) => f.name === "inner");
const body = disasm(m, inner);
assert.ok(body.some((l) => l.includes("i32.const 2")), "i32.const 2 decodes");
assert.ok(body.some((l) => l.includes("call $env.save")), "import calls resolve by name");
assert.equal(body.at(-1).trim().endsWith("end"), true, "body ends on its final end");

assert.deepEqual(
	callers(m, inner.index).hits.map((c) => c.fn),
	["outer"],
);
assert.deepEqual(
	xrefs(m, 2).hits.map((x) => `${x.fn}:${x.kind}`),
	["inner:const"],
);

// Patch $inner to x*5; the module must stay the same size and still validate.
const patched = patchBody(bytes, inner.index, new Uint8Array([0x20, 0x00, 0x41, 0x05, 0x6c]));
assert.equal(patched.bytes.length, bytes.length);
assert.ok(WebAssembly.validate(patched.bytes), "patched module validates");
const saved = [];
const imports = { env: { save: (v) => saved.push(v) } };
const { instance: pi } = await WebAssembly.instantiate(patched.bytes, imports);
assert.equal(pi.exports.run(6), 30, "patched body runs (6 * 5)");

// Export the internal $secret as "secret" and call it.
const exported = addExport(bytes, 1, "secret");
assert.ok(WebAssembly.validate(exported), "module with the added export validates");
const { instance: ei } = await WebAssembly.instantiate(exported, imports);
assert.equal(ei.exports.secret(7), 21, "added export is callable");

// A 64-bit constant sharing its low 32 bits with the address is not an xref to it.
const leb = (n) => {
	const out = [];
	do {
		let b = n % 128;
		n = Math.floor(n / 128);
		if (n) b |= 0x80;
		out.push(b);
	} while (n);
	return out;
};
const sect = (id, payload) => [id, ...leb(payload.length), ...payload];
const mixed = new Uint8Array([
	0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
	...sect(1, [1, 0x60, 0, 0]), // () -> ()
	...sect(3, [1, 0]), // one function
	...sect(10, [1, ...leb(12), 0, 0x42, ...leb(4294967298), 0x1a, 0x41, 2, 0x1a, 0x0b]), // i64.const 2^32+2; drop; i32.const 2; drop
]);
const mixedHits = xrefs(parseWasm(mixed), 2).hits;
assert.deepEqual(mixedHits.map((h) => h.text), ["i32.const 2"], "only the 32-bit constant matches");

// A module with no export section at all: addExport has to create the section.
const bare = new Uint8Array([
	0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, // magic + version
	1, 5, 1, 0x60, 0, 1, 0x7f, // type: () -> i32
	3, 2, 1, 0, // one function of that type
	10, 6, 1, 4, 0, 0x41, 1, 0x0b, // body: i32.const 1; end
]);
assert.equal(parseWasm(bare).exports.length, 0);
const withOne = addExport(bare, 0, "one");
assert.ok(WebAssembly.validate(withOne), "module with a newly created export section validates");
const { instance: bi } = await WebAssembly.instantiate(withOne, {});
assert.equal(bi.exports.one(), 1, "export added to a module that had none");

// Growing a body must be refused, not silently truncated.
assert.throws(() => patchBody(bytes, inner.index, new Uint8Array(99)), /has room for/);

await rm(OUT);
console.log("wasm.ts: parse, disasm, callers, xrefs, patch, addExport all OK");
