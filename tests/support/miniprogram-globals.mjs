// Preload for running the unit tests with the WeChat mini program's stand-ins
// for the browser globals: the tests assign jsdom's DOMParser at their top, and
// these locked properties make that assignment a no-op, so the engine (and the
// tests' own XML checks) run on miniprogram-engine/runtime.js instead.
import { importRuntime } from "../../miniprogram-engine/build.mjs";

const runtime = await importRuntime();

for (const name of ["DOMParser", "XMLSerializer", "TextEncoder", "TextDecoder", "Blob"]) {
  Object.defineProperty(globalThis, name, { configurable: false, get: () => runtime[name], set: () => {} });
}
