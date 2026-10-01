import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the PKUNMUN formatter product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>PKUNMUN 2026 文件自动排版系统<\/title>/i);
  assert.match(html, /把内容交给你/);
  assert.match(html, /立场文件/);
  assert.match(html, /非友好修正案/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("contains six explicit pipeline routes and no starter preview", async () => {
  const [page, backend] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../backend/app/pipelines.py", import.meta.url), "utf8"),
  ]);
  for (const type of ["position-paper", "working-paper", "draft-directive", "draft-resolution", "friendly-amendment", "unfriendly-amendment"]) {
    assert.match(page, new RegExp(type));
    assert.match(backend, new RegExp(type));
  }
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

