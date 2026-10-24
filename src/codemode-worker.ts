// Runs codemode's QuickJS VM off the panel thread: the remote side of pi's RemoteCodemodeSandbox, over postMessage.
import { type CodemodeRemoteReply, serveCodemodeRemote } from "@earendil-works/pi-codemode/portable";

const wasm = WebAssembly.compileStreaming(fetch("quickjs.wasm"));
const pending = new Map<number, (reply: CodemodeRemoteReply) => void>();
let next = 0;

onmessage = ({ data }) => {
	if ("reply" in data) {
		pending.get(data.id)?.(data.reply);
		pending.delete(data.id);
		return;
	}
	void serveCodemodeRemote(
		data.request,
		(messages) =>
			new Promise((resolve) => {
				const id = next++;
				pending.set(id, resolve);
				postMessage({ id, messages });
			}),
		{ wasm },
	).then(() => postMessage({ done: true }));
};
