// Files in IndexedDB, for what codemode saves when a script's output is too long, and a tool to read them back.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type ExecutionEnv, err, FileError, ok } from "@earendil-works/pi-durable/env";

const KEEP_MS = 7 * 24 * 3600_000;
type File = { data: string | Uint8Array; at: number };

const db = new Promise<IDBDatabase>((resolve, reject) => {
	const q = indexedDB.open("pi-debugger-files", 1);
	q.onupgradeneeded = () => q.result.createObjectStore("files");
	q.onsuccess = () => resolve(q.result);
	q.onerror = () => reject(q.error);
});
const request = <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) =>
	db.then(
		(d) =>
			new Promise<T>((resolve, reject) => {
				const q = run(d.transaction("files", mode).objectStore("files"));
				q.onsuccess = () => resolve(q.result);
				q.onerror = () => reject(q.error);
			}),
	);

// Drop files older than a week when the panel opens.
void db.then((d) => {
	const q = d.transaction("files", "readwrite").objectStore("files").openCursor();
	q.onsuccess = () => {
		const c = q.result;
		if (!c) return;
		if (Date.now() - (c.value as File).at > KEEP_MS) c.delete();
		c.continue();
	};
});

// ponytail: only the two methods codemode calls (createTempDir, writeFile); a tool that needs more of ExecutionEnv will throw
export const filesEnv = {
	createTempDir: async (prefix?: string) => ok(`/tmp/${prefix ?? ""}${crypto.randomUUID().slice(0, 8)}`),
	writeFile: async (path: string, data: string | Uint8Array) => {
		try {
			await request("readwrite", (s) => s.put({ data, at: Date.now() } satisfies File, path));
			return ok(undefined);
		} catch (e) {
			return err(new FileError("unknown", String(e), path));
		}
	},
} as unknown as ExecutionEnv;

const readFile = defineTool({
	name: "read_file",
	description:
		"Read a file saved by codemode, such as the full output of a script whose output was cut. Files are kept for a week.",
	parameters: Type.Object({
		path: Type.String(),
		offset: Type.Optional(Type.Number({ description: "First line, 1-based; default 1" })),
		limit: Type.Optional(Type.Number({ description: "Number of lines; default 500" })),
	}),
	execute: async ({ path, offset = 1, limit = 500 }) => {
		const file = await request<File | undefined>("readonly", (s) => s.get(path));
		if (!file) return { output: [{ type: "text", text: `No such file: ${path}` }], isError: true };
		if (typeof file.data !== "string") {
			return { output: [{ type: "text", text: `${path} is binary (${file.data.length} bytes)` }], isError: true };
		}
		const lines = file.data.split("\n");
		const end = Math.min(lines.length, offset - 1 + limit);
		const more = end < lines.length ? `\n\n[Lines ${offset}-${end} of ${lines.length}; continue with offset ${end + 1}]` : "";
		return { output: [{ type: "text", text: lines.slice(offset - 1, end).join("\n") + more }] };
	},
});

export const FileTools = defineExtension({ name: "files", tools: [readFile] });
