import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../hussamfaroug-com-worker.js", import.meta.url), "utf8");
const moduleSource = source.replace(
  "worker_default as default",
  "worker_default as default, convertMd, botAuth"
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

test("bot-auth signature uses a structured-field byte sequence", async () => {
  const response = await worker.botAuth(
    new Request("https://hussamfaroug.com/.well-known/http-message-signatures-directory"),
    {}
  );
  assert.match(response.headers.get("Signature"), /^sig1=:[A-Za-z0-9+/]+={0,2}:$/);
});

test("Markdown conversion and response token count preserve UTF-8 output", async () => {
  const html = "<html><head><title>Résumé &amp; 🙂</title></head><body><main><h1>Hello &amp; 世界</h1><p>Hi <strong>there</strong>.</p></main></body></html>";
  const expected = "# Résumé & 🙂\n\n# Hello & 世界\n\nHi **there**.";
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
    assert.equal(response.headers.get("Vary"), "Accept");
    assert.equal(
      response.headers.get("x-markdown-tokens"),
      String(Math.max(1, Math.ceil(new TextEncoder().encode(expected).length / 4)))
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HEAD requests use normal routes and maintenance checks without a body", async () => {
  const originalFetch = globalThis.fetch;
  let fetchMethod;
  globalThis.fetch = async (_url, options) => {
    fetchMethod = options.method;
    return new Response(null, { status: 404, headers: { "Content-Type": "text/plain" } });
  };
  try {
    const missing = await worker.default.fetch(new Request("https://hussamfaroug.com/missing", {
      method: "HEAD"
    }), {});
    assert.equal(fetchMethod, "HEAD");
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "");

    const maintenance = await worker.default.fetch(new Request("https://hussamfaroug.com/missing", {
      method: "HEAD"
    }), { FLAGS: { getBooleanValue: async () => true } });
    assert.equal(maintenance.status, 503);
    assert.equal(maintenance.headers.get("Cache-Control"), "no-store");
    assert.equal(await maintenance.text(), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTML responses vary by Accept and filter the legacy bridge script", async () => {
  const originalFetch = globalThis.fetch;
  const originalHTMLRewriter = globalThis.HTMLRewriter;
  const selectors = [];
  globalThis.fetch = async () => new Response("<html><head></head><body>Page</body></html>", {
    headers: { "Content-Type": "text/html; charset=utf-8", Vary: "Origin" }
  });
  globalThis.HTMLRewriter = class {
    on(selector) {
      selectors.push(selector);
      return this;
    }

    transform(response) {
      return response;
    }
  };
  try {
    const response = await worker.default.fetch(new Request("https://hussamfaroug.com/page"), {});
    assert.equal(response.headers.get("Vary"), "Origin, Accept");
    assert.ok(selectors.includes("script[src]"));
    assert.ok(response.body);
    await response.body.cancel();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHTMLRewriter === undefined) delete globalThis.HTMLRewriter;
    else globalThis.HTMLRewriter = originalHTMLRewriter;
  }
});

test("Markdown conversion handles formatting, nested markup, links, and lists", () => {
  const html = "<main><p><strong>Bold <span>text</span></strong> and <em>italic</em>, plus <b>bold</b> and <i>italic</i>.</p><ul><li><a href=\"/first\">First</a></li><li>Second</li></ul><ol><li>Third</li><li>Fourth</li></ol></main>";
  const expected = [
    "**Bold text** and *italic*, plus **bold** and *italic*.",
    "- [First](https://hussamfaroug.com/first)\n- Second",
    "1. Third\n2. Fourth"
  ].join("\n\n");

  assert.equal(worker.convertMd(html, "https://hussamfaroug.com"), expected);
});

test("Markdown conversion strips tags and escapes remaining angle brackets", () => {
  const html = "<main><p><span>Nested text</span>: 2 < 3 &amp;&amp; 4 &gt; 1.</p><!-- removed -->unfinished <script</main>";
  assert.equal(
    worker.convertMd(html, "https://hussamfaroug.com"),
    "Nested text: 2 &lt; 3 && 4 &gt; 1.\nunfinished &lt;script"
  );
});

test("Markdown conversion handles larger HTML documents", () => {
  const paragraphCount = 5000;
  const html = `<main>${"<p>large document</p>".repeat(paragraphCount)}</main>`;
  const expected = Array(paragraphCount).fill("large document").join("\n\n");

  assert.equal(worker.convertMd(html, "https://hussamfaroug.com"), expected);
});
