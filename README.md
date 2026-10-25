# Pi Debugger

A Chrome side-panel extension that puts an AI agent in your browser. It inspects and changes the tab the panel is attached to
over the DevTools Protocol — JS state, screenshots, real mouse/keyboard input, console, network, storage — and
reverse-engineers WebAssembly: functions, disassembly, xrefs, callers, patching, new exports, and breakpoints
that capture wasm-to-wasm stacks and locals.

## Build and load

```bash
npm install && npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and select `dist/`.
Click the toolbar icon, paste an OpenRouter or OpenCode Go key in Settings, and ask about the page.

Checks: `npm run check` (types), `node test/wasm.test.mjs` (wasm toolkit, no browser),
`node test/e2e.mjs` (end to end; needs Chrome and `test/site` served on :8765).
