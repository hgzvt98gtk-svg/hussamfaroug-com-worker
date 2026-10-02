import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../hussamfaroug-com-worker.js", import.meta.url), "utf8");
const moduleSource = source.replace(
  "worker_default as default",
  "worker_default as default, convertMd"
);
assert.notEqual(moduleSource, source, "Worker exports should be available to tests");
const worker = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);

test("metadata responses preserve content types and cache policies", async () => {
  const health = await worker.default.fetch(new Request("https://hussamfaroug.com/.well-known/health"), {});
  assert.equal(health.headers.get("Cache-Control"), "no-store");
  assert.equal((await health.json()).status, "ok");

  const agentCard = await worker.default.fetch(new Request("https://hussamfaroug.com/.well-known/agent-card.json"), {});
  assert.equal(agentCard.headers.get("Cache-Control"), "no-store");
  assert.equal((await agentCard.json()).name, "HussamFaroug Agent");

  const apiCatalog = await worker.default.fetch(new Request("https://hussamfaroug.com/.well-known/api-catalog"), {});
  assert.equal(apiCatalog.headers.get("Content-Type"), "application/linkset+json");
  assert.equal(apiCatalog.headers.get("Cache-Control"), "public, max-age=3600");
});

test("Markdown conversion and response token count preserve UTF-8 output", async () => {
  const html = "<html><head><title>Résumé &amp; 🙂</title></head><body><main><h1>Hello &amp; 世界</h1><p>Hi <strong>there</strong>.</p></main></body></html>";
  const expected = "# Résumé & 🙂\n\n# Hello & 世界\n\nHi **strong**.";
  assert.equal(worker.convertMd(html, "https://hussamfaroug.com"), expected);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
  try {
    const response = await worker.default.fetch(new Request("https://hussamfaroug.com/page", {
      headers: { Accept: "text/markdown" }
    }), {});
    assert.equal(await response.text(), expected);
    assert.equal(
      response.headers.get("x-markdown-tokens"),
      String(Math.max(1, Math.ceil(new TextEncoder().encode(expected).length / 4)))
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
