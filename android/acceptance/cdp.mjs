// A minimal DevTools protocol client over Node's built-in WebSocket, for desktop Chromium builds back to 66 and
// Android WebViews back to 37 (Android 5.0): plain Runtime.evaluate, no awaitPromise, both ways old and new
// engines report an exception.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Cdp {
  static async open(port, { match = () => true, timeout = 30000 } = {}) {
    const end = Date.now() + timeout;
    let target;
    while (!target && Date.now() < end) {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => undefined);
      target = targets?.find((t) => t.type === "page" && t.webSocketDebuggerUrl && match(t));
      if (!target) await sleep(500);
    }
    if (!target) throw new Error(`no page on DevTools port ${port}`);
    const cdp = new Cdp();
    cdp.url = target.url;
    // The forwarded port is what reaches the page; the address in the listing may name another host.
    cdp.ws = new WebSocket(target.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`));
    cdp.pending = new Map();
    cdp.id = 0;
    cdp.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && cdp.pending.has(message.id)) {
        const { resolve, reject } = cdp.pending.get(message.id);
        cdp.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      }
    };
    cdp.ws.onclose = () => {
      for (const { reject } of cdp.pending.values()) reject(new Error("DevTools connection closed"));
      cdp.pending.clear();
    };
    await new Promise((resolve, reject) => { cdp.ws.onopen = resolve; cdp.ws.onerror = reject; });
    return cdp;
  }

  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
  }

  // userGesture: as if the user had tapped (a file input opens its chooser only then).
  async eval(expression, { userGesture = false } = {}) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, ...(userGesture ? { userGesture: true } : {}) });
    if (result.exceptionDetails || result.wasThrown) {
      throw new Error(result.exceptionDetails?.exception?.description || result.result?.description || result.exceptionDetails?.text || "exception");
    }
    return result.result.value;
  }

  async until(expression, timeout = 60000, describe = null) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(expression).catch(() => false)) return;
      await sleep(200);
    }
    const state = describe ? await this.eval(describe).catch((error) => String(error)) : "";
    throw new Error(`timed out waiting for ${expression.slice(0, 100)}${state ? ` (page: ${state})` : ""}`);
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

// What the page shows, for error messages.
export const PAGE_STATE = `JSON.stringify({ selected: (document.querySelector(".typeCard.selected b") || {}).textContent, file: (document.querySelector(".dropzone h3") || {}).textContent, hasFile: !!document.querySelector(".dropzone.hasFile"), error: (document.querySelector(".errorBox") || {}).textContent, headings: [].map.call(document.querySelectorAll("h2"), function (h) { return h.textContent; }), body: document.body ? document.body.innerText.slice(0, 200) : "" })`;
