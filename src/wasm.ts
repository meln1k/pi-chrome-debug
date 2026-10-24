// Minimal WebAssembly binary toolkit: sections, function bodies, names, disassembly, patching.
// Pure bytes, no DOM and no Chrome: the panel tool and the node test both use it.
// Decoding is linear per function body and validated against the body's declared size, so an
// opcode this table does not know fails that function loudly instead of silently derailing.

export type WasmType = { params: string[]; results: string[] };
export type WasmFunc = {
	index: number; // module function index: imports come first
	typeIdx: number;
	name?: string;
	params: string[];
	results: string[];
	bodyStart: number; // first instruction, after the locals declaration
	bodyEnd: number; // exclusive; a well-formed body ends with 0x0b at bodyEnd - 1
	size: number;
};
export type WasmExport = { name: string; kind: number; index: number };
export type WasmSection = { id: number; header: number; start: number; end: number };
export type WasmModule = {
	bytes: Uint8Array;
	types: WasmType[];
	imports: { index: number; name: string }[]; // function imports, lowest indices
	funcs: WasmFunc[];
	fnNames: Map<number, string>; // index -> name, imports and defined functions
	exports: WasmExport[];
	sections: WasmSection[];
};
export type Instr = { offset: number; name: string; text: string; call?: number; const?: number; constWidth?: 32 | 64; memOffset?: number; size: number };

const VAL: Record<number, string> = {
	0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128",
	0x70: "funcref", 0x6f: "externref", 0x6e: "anyref", 0x6d: "eqref", 0x6c: "i31ref", 0x6b: "structref", 0x6a: "arrayref",
};
const val = (b: number) => VAL[b] ?? `type 0x${b.toString(16)}`;

class R {
	pos: number;
	constructor(
		readonly b: Uint8Array,
		pos = 0,
	) {
		this.pos = pos;
	}
	u8() {
		return this.b[this.pos++];
	}
	/** Unsigned LEB128 up to 2^53; the values we read (sizes, indices, offsets) are all u32 or smaller. */
	u() {
		let r = 0;
		let mul = 1;
		for (;;) {
			const x = this.b[this.pos++];
			r += (x & 0x7f) * mul;
			if (!(x & 0x80)) return r;
			mul *= 128;
		}
	}
	/** Signed LEB128, for i32.const / i64.const display. */
	s(bits = 32) {
		let r = 0;
		let mul = 1;
		let x: number;
		do {
			x = this.b[this.pos++];
			r += (x & 0x7f) * mul;
			mul *= 128;
		} while (x & 0x80);
		if (x & 0x40) r -= mul;
		return bits <= 32 ? r | 0 : r;
	}
	str() {
		const n = this.u();
		const s = new TextDecoder().decode(this.b.subarray(this.pos, this.pos + n));
		this.pos += n;
		return s;
	}
	skip(n: number) {
		this.pos += n;
	}
	lim() {
		if (this.u8() === 0) this.u();
		else {
			this.u();
			this.u();
		}
	}
}

/** Section list plus the parts of a module the toolkit asks about. */
export function parseWasm(bytes: Uint8Array): WasmModule {
	if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("not a wasm module");
	const types: WasmType[] = [];
	const sections: WasmSection[] = [];
	const exports: WasmExport[] = [];
	const names = new Map<number, string>();
	const imports: { index: number; name: string }[] = [];
	const typeIdxs: number[] = [];
	const bodies: { start: number; end: number; localsStart: number }[] = [];
	let importedFuncs = 0;
	for (let r = new R(bytes, 8); r.pos < bytes.length; ) {
		const header = r.pos;
		const id = r.u8();
		const size = r.u();
		const start = r.pos;
		const end = start + size;
		if (end > bytes.length) throw new Error(`section ${id} runs past the end of the module`);
		if (id === 0) {
			const sub = r.pos;
			const nameLen = r.u();
			const name = new TextDecoder().decode(bytes.subarray(r.pos, r.pos + nameLen));
			r.pos += nameLen;
			if (name === "name") {
				while (r.pos < end) {
					const kind = r.u8();
					const len = r.u();
					const stop = r.pos + len;
					if (kind === 1) for (let n = r.u(); n > 0; n--) names.set(r.u(), r.str());
					r.pos = stop;
				}
			}
			r.pos = sub; // custom sections are not stored
		} else if (id === 1) {
			for (let n = r.u(); n > 0; n--) {
				if (r.u8() !== 0x60) throw new Error("unsupported type form");
				const params: string[] = [];
				for (let p = r.u(); p > 0; p--) params.push(val(r.u8()));
				const results: string[] = [];
				for (let q = r.u(); q > 0; q--) results.push(val(r.u8()));
				types.push({ params, results });
			}
		} else if (id === 2) {
			for (let n = r.u(); n > 0; n--) {
				const mod = r.str();
				const field = r.str();
				const kind = r.u8();
				if (kind === 0) {
					r.u();
					imports.push({ index: importedFuncs++, name: `${mod}.${field}` });
				} else if (kind === 1) {
					r.u8();
					r.lim();
				} else if (kind === 2) r.lim();
				else if (kind === 3) {
					r.u8();
					r.u8();
				} else if (kind === 4) {
					r.u8();
					r.u();
				} else throw new Error(`unsupported import kind ${kind}`);
			}
		} else if (id === 3) {
			for (let n = r.u(); n > 0; n--) typeIdxs.push(r.u());
		} else if (id === 7) {
			for (let n = r.u(); n > 0; n--) {
				const name = r.str();
				const kind = r.u8();
				exports.push({ name, kind, index: r.u() });
			}
		} else if (id === 10) {
			for (let n = r.u(); n > 0; n--) {
				const size2 = r.u();
				const bodyEnd = r.pos + size2;
				const localsStart = r.pos;
				for (let groups = r.u(); groups > 0; groups--) {
					r.u();
					r.u8();
				}
				bodies.push({ start: r.pos, end: bodyEnd, localsStart });
				r.pos = bodyEnd;
			}
		}
		r.pos = end;
		sections.push({ id, header, start, end });
	}
	// Imports keep their qualified module.field name (what V8 prints); the name section names the rest.
	const fnNames = new Map<number, string>(names);
	for (const i of imports) fnNames.set(i.index, i.name);
	const funcs: WasmFunc[] = bodies.map((b, i) => {
		const index = importedFuncs + i;
		const typeIdx = typeIdxs[i] ?? -1;
		const t = types[typeIdx] ?? { params: [], results: [] };
		return { index, typeIdx, name: names.get(index), params: t.params, results: t.results, bodyStart: b.start, bodyEnd: b.end, size: b.end - b.start };
	});
	for (const e of exports) if (e.kind === 0 && funcs.length) {
		const f = funcs.find((f) => f.index === e.index);
		if (f) f.name ??= e.name;
	}
	return { bytes, types, imports, funcs, fnNames, exports, sections };
}

// Numeric opcodes 0x45..0xc4, in order.
const OPS =
	"i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u " +
	"i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u " +
	"f32.eq f32.ne f32.lt f32.gt f32.le f32.ge f64.eq f64.ne f64.lt f64.gt f64.le f64.ge " +
	"i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or i32.xor i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr " +
	"i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr " +
	"f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min f32.max f32.copysign " +
	"f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add f64.sub f64.mul f64.div f64.min f64.max f64.copysign " +
	"i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u " +
	"f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u f64.promote_f32 " +
	"i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64 i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s";
const OP_NAMES = OPS.split(" ");

const plain: Record<number, string> = {
	0x00: "unreachable", 0x01: "nop", 0x02: "block", 0x03: "loop", 0x04: "if", 0x05: "else", 0x06: "try", 0x07: "catch",
	0x08: "throw", 0x09: "rethrow", 0x0a: "throw_ref", 0x0b: "end", 0x0c: "br", 0x0d: "br_if", 0x0e: "br_table",
	0x0f: "return", 0x10: "call", 0x11: "call_indirect", 0x12: "return_call", 0x13: "return_call_indirect",
	0x14: "call_ref", 0x15: "return_call_ref", 0x18: "delegate", 0x19: "catch_all", 0x1a: "drop", 0x1b: "select",
	0x1c: "select", 0x1f: "try_table",
	0x20: "local.get", 0x21: "local.set", 0x22: "local.tee", 0x23: "global.get", 0x24: "global.set",
	0x25: "table.get", 0x26: "table.set",
	0x28: "i32.load", 0x29: "i64.load", 0x2a: "f32.load", 0x2b: "f64.load", 0x2c: "i32.load8_s", 0x2d: "i32.load8_u",
	0x2e: "i32.load16_s", 0x2f: "i32.load16_u", 0x30: "i64.load8_s", 0x31: "i64.load8_u", 0x32: "i64.load16_s",
	0x33: "i64.load16_u", 0x34: "i64.load32_s", 0x35: "i64.load32_u", 0x36: "i32.store", 0x37: "i64.store",
	0x38: "f32.store", 0x39: "f64.store", 0x3a: "i32.store8", 0x3b: "i32.store16", 0x3c: "i64.store8",
	0x3d: "i64.store16", 0x3e: "i64.store32", 0x3f: "memory.size", 0x40: "memory.grow",
	0x41: "i32.const", 0x42: "i64.const", 0x43: "f32.const", 0x44: "f64.const",
	0xd0: "ref.null", 0xd1: "ref.is_null", 0xd2: "ref.func",
};

/**
 * Decode one function body into instructions. Throws if the body does not end exactly on its
 * declared boundary, which is how an unknown opcode surfaces instead of corrupting the listing.
 */
export function decode(m: WasmModule, f: WasmFunc): Instr[] {
	const b = m.bytes;
	const out: Instr[] = [];
	const r = new R(b, f.bodyStart);
	/** Immediate readers; each returns display text. */
	const leb = (label: string) => {
		const v = r.u();
		return `${label}${v}`;
	};
	const fnName = (idx: number) => m.fnNames.get(idx) ?? `func${idx}`;
	const memarg = () => {
		const align = r.u();
		const offset = r.u();
		if (offset) out[out.length - 1]!.memOffset = offset;
		return `offset=${offset}${align ? ` align=${2 ** align}` : ""}`;
	};
	while (r.pos < f.bodyEnd) {
		const offset = r.pos;
		const op = r.u8();
		let name = plain[op] ?? (op >= 0x45 && op <= 0xc4 ? OP_NAMES[op - 0x45]! : `op 0x${op.toString(16)}`);
		let text = name;
		let call: number | undefined;
		if (op === 0x02 || op === 0x03 || op === 0x04 || op === 0x06 || op === 0x1f) {
			const bt = r.u8();
			if (bt !== 0x40) {
				r.pos--;
				r.s(33);
			}
			if (op === 0x1f) {
				for (let n = r.u(); n > 0; n--) {
					const kind = r.u8();
					r.u();
					if (kind === 2 || kind === 3) r.u();
				}
			}
		} else if (op === 0x07 || op === 0x08 || op === 0x09 || op === 0x18) text = `${name} ${leb("")}`; // tag or label index
		else if (op === 0x0c || op === 0x0d) text = `${name} ${leb("")}`;
		else if (op === 0x0e) {
			const n = r.u();
			const labels: number[] = [];
			for (let i = 0; i <= n; i++) labels.push(r.u());
			text = `${name} ${labels.join(" ")}`;
		} else if (op === 0x10 || op === 0x12) {
			call = r.u();
			text = `${name} $${fnName(call)}`;
		} else if (op === 0x11 || op === 0x13) {
			text = `${name} ${leb("type ")} ${leb("table ")}`;
		} else if (op === 0x14 || op === 0x15) text = `${name} ${leb("type ")}`;
		else if (op === 0x1c) {
			const types: string[] = [];
			for (let n = r.u(); n > 0; n--) types.push(val(r.u8()));
			text = `select ${types.join(" ")}`;
		} else if (op >= 0x20 && op <= 0x26) text = `${name} ${leb("")}`;
		else if (op >= 0x28 && op <= 0x3e) text = `${name} ${memarg()}`;
		else if (op === 0x3f || op === 0x40) text = `${name} ${leb("")}`;
		else if (op === 0x41) {
			const v = r.s(32);
			out.push({ offset, name, text: `${name} ${v}`, const: v, constWidth: 32, size: r.pos - offset });
			continue;
		} else if (op === 0x42) {
			const v = r.s(64);
			out.push({ offset, name, text: `${name} ${v}`, const: v, constWidth: 64, size: r.pos - offset });
			continue;
		} else if (op === 0x43) {
			const v = new DataView(b.buffer, b.byteOffset + r.pos, 4).getFloat32(0, true);
			r.skip(4);
			text = `${name} ${v}`;
		} else if (op === 0x44) {
			const v = new DataView(b.buffer, b.byteOffset + r.pos, 8).getFloat64(0, true);
			r.skip(8);
			text = `${name} ${v}`;
		} else if (op === 0xd0) text = `${name} ${leb("type ")}`;
		else if (op === 0xd2) text = `${name} $${fnName(r.u())}`;
		else if (op === 0xfb) throw new Error(`GC opcode 0xfb at 0x${offset.toString(16)}`);
		else if (op === 0xfc) {
			const sub = r.u();
			name = `fc.${sub}`;
			if (sub === 8) text = `${name} ${leb("data ")} ${leb("mem ")}`;
			else if (sub === 9 || sub === 11 || sub === 13) text = `${name} ${leb("")}`;
			else if (sub === 10 || sub === 12 || sub === 14 || sub === 15 || sub === 16 || sub === 17) text = `${name} ${leb("")} ${leb("")}`;
			else text = name;
		} else if (op === 0xfd) {
			const sub = r.u();
			name = `simd.${sub}`;
			text = name;
			if (sub <= 11) text = `${name} ${memarg()}`;
			else if (sub === 12 || sub === 13) r.skip(16);
			else if (sub >= 21 && sub <= 34) r.skip(1);
			else if (sub === 92 || sub === 93) text = `${name} ${memarg()}`; // v128.load32_zero / load64_zero
			else if (sub >= 84 && sub <= 91) {
				r.u();
				r.u();
				r.skip(1);
			}
		} else if (op === 0xfe) {
			const sub = r.u();
			name = `atomic.${sub}`;
			if (sub === 3) r.skip(1);
			else memarg();
			text = name;
		}
		out.push({ offset, name, text, call, size: r.pos - offset });
	}
	if (r.pos !== f.bodyEnd) throw new Error(`function ${f.index} decoded past its body (0x${r.pos.toString(16)} > 0x${f.bodyEnd.toString(16)})`);
	return out;
}

export const fmtType = (f: WasmFunc) => `(${f.params.join(" ")})${f.results.length ? ` -> (${f.results.join(" ")})` : ""}`;

export function disasm(m: WasmModule, f: WasmFunc) {
	return decode(m, f).map((i) => `0x${i.offset.toString(16)}  ${i.text}`);
}

/** Decode every body, skipping the ones the opcode table does not know instead of failing the scan. */
function scan<T>(m: WasmModule, each: (f: WasmFunc, i: Instr) => T | undefined, failed: number[] = []) {
	const out: T[] = [];
	for (const f of m.funcs) {
		let code: Instr[];
		try {
			code = decode(m, f);
		} catch {
			failed.push(f.index);
			continue;
		}
		for (const i of code) {
			const hit = each(f, i);
			if (hit !== undefined) out.push(hit);
		}
	}
	return { hits: out, skipped: failed };
}

/** Every call site of fnIdx, and every place that names it. */
export function callers(m: WasmModule, fnIdx: number) {
	return scan(m, (f, i) => (i.call === fnIdx ? { fn: f.name ?? `func${f.index}`, index: f.index, offset: i.offset, text: i.text } : undefined));
}

/** Instructions that mention addr: i32.const of it, and memory operands with that offset. */
export function xrefs(m: WasmModule, addr: number) {
	return scan(m, (f, i) =>
		i.const !== undefined && (i.const === addr || (i.constWidth === 32 && addr <= 0xffffffff && i.const >>> 0 === addr))
			? { fn: f.name ?? `func${f.index}`, index: f.index, offset: i.offset, text: i.text, kind: "const" as const }
			: i.memOffset === addr
				? { fn: f.name ?? `func${f.index}`, index: f.index, offset: i.offset, text: i.text, kind: "mem" as const }
				: undefined,
	);
}

/** Replace a body's instructions, padding the tail with nops so every other offset stays put. */
export function patchBody(bytes: Uint8Array, fnIdx: number, replacement: Uint8Array) {
	const m = parseWasm(bytes);
	const f = m.funcs.find((x) => x.index === fnIdx);
	if (!f) throw new Error(`no function ${fnIdx}`);
	const room = f.bodyEnd - 1 - f.bodyStart; // keep the trailing end byte
	if (replacement.length > room) throw new Error(`replacement is ${replacement.length} bytes, function ${fnIdx} has room for ${room}`);
	const out = bytes.slice();
	out.set(replacement, f.bodyStart);
	out.fill(0x01, f.bodyStart + replacement.length, f.bodyEnd - 1);
	return { bytes: out, fn: f, room };
}

const lebBytes = (n: number) => {
	const out: number[] = [];
	do {
		let x = n & 0x7f;
		n = Math.floor(n / 128);
		if (n) x |= 0x80;
		out.push(x);
	} while (n);
	return out;
};

/** Append an export for an existing function; the module keeps its code but grows its export section. */
export function addExport(bytes: Uint8Array, fnIdx: number, name: string) {
	const m = parseWasm(bytes);
	if (!m.funcs.some((f) => f.index === fnIdx)) throw new Error(`no function ${fnIdx}`);
	if (m.exports.some((e) => e.name === name)) throw new Error(`export "${name}" already exists`);
	const entry = [...lebBytes(name.length), ...new TextEncoder().encode(name), 0x00, ...lebBytes(fnIdx)];
	const existing = m.sections.find((s) => s.id === 7);
	let section: number[];
	if (existing) {
		const r = new R(bytes, existing.start);
		const count = r.u();
		section = [...lebBytes(count + 1), ...bytes.subarray(r.pos, existing.end), ...entry];
	} else section = [...lebBytes(1), ...entry];
	const payload = [0x07, ...lebBytes(section.length), ...section];
	const at = existing ? existing.header : (m.sections.find((s) => s.id > 7)?.header ?? bytes.length);
	return new Uint8Array([...bytes.subarray(0, at), ...payload, ...bytes.subarray(existing ? existing.end : at)]);
}

export const hasMagic = (b: Uint8Array) => b.length > 8 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;

export function bytesFromBase64(s: string) {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function base64FromBytes(b: Uint8Array) {
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s);
}
