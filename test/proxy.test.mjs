import assert from "node:assert/strict";
import test from "node:test";
import worker from "../hussamfaroug-com-worker.js";
import { fetchOrigin, MAX_HTML_BYTES, ORIGIN_TIMEOUT_MS, prefersMarkdown, readHtml } from "../proxy.js";

const env = { ORIGIN: "https://origin.example" };

test("Accept negotiation respects specificity, quality, and HTML defaults", () => {
  for (const accept of ["", "*/*", "text/*", "text/markdown;q=0", "text/markdown;q=0.3,text/html;q=1", "text/markdown;q=bogus"]) {
    assert.equal(prefersMarkdown(accept), false, accept);
  }
  for (const accept of ["text/markdown", "TEXT/MARKDOWN", "text/html;q=0.1,text/markdown;q=0.8", "*/*;q=1,text/html;q=0,text/markdown;q=0.5"]) {
    assert.equal(prefersMarkdown(accept), true, accept);
  }
});

test("proxy confines slash paths and strips credentials and nominated hop headers", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response("ok");
  };
  try {
    for (const path of ["//attacker.example/payload", "/%2f%2fattacker.example/page", "/normal?q=1"]) {
      const response = await worker.fetch(new Request("https://site.example" + path, {
        headers: { Cookie: "session=test", Authorization: "******", Connection: "X-Hop", "X-Hop": "remove", "X-Test": "keep" }
      }), env);
      assert.equal(await response.text(), "ok");
      const { url, options } = calls.at(-1);
      assert.equal(new URL(url).origin, env.ORIGIN);
      for (const name of ["cookie", "authorization", "connection", "x-hop"]) assert.equal(options.headers.has(name), false);
      assert.equal(options.headers.get("X-Test"), "keep");
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("write methods are rejected before local routing or origin access", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    for (const path of ["/page", "/.well-known/health", "/auth.md"]) {
      const response = await worker.fetch(new Request("https://site.example" + path, { method }), env);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("Allow"), "GET, HEAD, OPTIONS");
    }
  }
});

test("invalid origins fail closed", async () => {
  for (const ORIGIN of ["invalid", "file:///tmp/site", "******origin.example", "https://site.example"]) {
    assert.equal((await worker.fetch(new Request("https://site.example/page"), { ORIGIN })).status, 500);
  }
});

test("bounded HTML reads decode split UTF-8, cancel oversized and failed bodies", async () => {
  const bytes = new TextEncoder().encode("🙂");
  const split = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2));
      controller.close();
    }
  }));
  assert.equal(await readHtml(split), "🙂");
  let canceled = false;
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_HTML_BYTES + 1)); },
    cancel() { canceled = true; }
  }));
  await assert.rejects(readHtml(oversized), /limit exceeded/);
  assert.equal(canceled, true);
  const failed = new Response(new ReadableStream({
    start(controller) { controller.error(new Error("broken body")); }
  }));
  await assert.rejects(readHtml(failed), /broken body/);
});

test("origin timeout and request abort reach fetch and streaming cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let expire;
  let signal;
  let canceled = false;
  globalThis.setTimeout = (callback, milliseconds) => {
    assert.equal(milliseconds, ORIGIN_TIMEOUT_MS);
    expire = callback;
    return 123;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ cancel() { canceled = true; } }));
  };
  try {
    const request = new AbortController();
    const response = await fetchOrigin(env.ORIGIN, new Headers(), request.signal);
    expire();
    assert.equal(signal.aborted, true);
    await response.body.cancel();
    assert.equal(canceled, true);
    const request2 = new AbortController();
    const response2 = await fetchOrigin(env.ORIGIN, new Headers(), request2.signal);
    request2.abort();
    assert.equal(signal.aborted, true);
    await response2.body.cancel();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
  }
});
