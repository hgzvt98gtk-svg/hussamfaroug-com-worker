import assert from "node:assert/strict";
import test from "node:test";
import { HTMLRewriter as WasmHTMLRewriter } from "html-rewriter-wasm";
import worker from "../hussamfaroug-com-worker.js";
import { botAuth } from "../bot-auth.js";
import { convertMd } from "../markdown.js";
import { MAX_HTML_BYTES } from "../proxy.js";

const testEnv = { ORIGIN: "https://hgzvt98gtk-svg-github-io.pages.dev" };

globalThis.HTMLRewriter = class {
  constructor() {
    this.handlers = [];
  }

  on(selector, handler) {
    this.handlers.push(["on", selector, handler]);
    return this;
  }

  onDocument(handler) {
    this.handlers.push(["onDocument", handler]);
    return this;
  }

  transform(response) {
    const output = new ReadableStream({
      start: async (controller) => {
        const rewriter = new WasmHTMLRewriter((chunk) => controller.enqueue(chunk.slice()));
        try {
          for (const [method, ...args] of this.handlers) rewriter[method](...args);
          for await (const chunk of response.body) await rewriter.write(chunk);
          await rewriter.end();
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          rewriter.free();
        }
      }
    });
    return new Response(output, response);
  }
};

test("metadata responses preserve content types and cache policies", async () => {
  assert.equal(worker.scheduled, undefined);

  const health = await worker.fetch(new Request("https://hussamfaroug.com/.well-known/health"), testEnv);
  assert.equal(health.headers.get("Cache-Control"), "no-store");
  assert.equal((await health.json()).status, "ok");

  const agentCard = await worker.fetch(new Request("https://hussamfaroug.com/.well-known/agent-card.json"), testEnv);
  assert.equal(agentCard.headers.get("Cache-Control"), "no-store");
  assert.equal((await agentCard.json()).name, "HussamFaroug Agent");

  const apiCatalog = await worker.fetch(new Request("https://hussamfaroug.com/.well-known/api-catalog"), testEnv);
  assert.equal(apiCatalog.headers.get("Content-Type"), "application/linkset+json");
  assert.equal(apiCatalog.headers.get("Cache-Control"), "public, max-age=3600");
});

test("bot-auth signature uses a structured-field byte sequence", async () => {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const response = await botAuth(
    new Request("https://hussamfaroug.com/.well-known/http-message-signatures-directory"),
    { SITE_CONFIG: { get: async () => JSON.stringify(privateJwk) } }
  );
  assert.match(response.headers.get("Signature"), /^sig1=:[A-Za-z0-9+/]+={0,2}:$/);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=240");
  const signatureInput = response.headers.get("Signature-Input");
  const signatureParams = signatureInput.slice(signatureInput.indexOf("=") + 1);
  const signatureAgent = response.headers.get("Signature-Agent");
  const signatureBase = [
    '"@authority": hussamfaroug.com',
    `"signature-agent": ${signatureAgent}`,
    `"@signature-params": ${signatureParams}`
  ].join("\n");
  const { keys: [publicKey] } = await response.json();
  const verificationKey = await crypto.subtle.importKey(
    "jwk",
    { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x },
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  const signature = Buffer.from(response.headers.get("Signature").match(/^sig1=:([^:]+):$/)[1], "base64");
  assert.equal(
    await crypto.subtle.verify("Ed25519", verificationKey, signature, new TextEncoder().encode(signatureBase)),
    true
  );
  const created = Number(signatureInput.match(/created=(\d+)/)[1]);
  const expires = Number(signatureInput.match(/expires=(\d+)/)[1]);
  const maxAge = Number(response.headers.get("Cache-Control").match(/max-age=(\d+)/)[1]);
  assert.ok(maxAge < expires - created);
});

test("Markdown conversion and response token count preserve UTF-8 output", async () => {
  const html = "<html><head><title>Résumé &amp; 🙂</title></head><body><main><h1>Hello &amp; 世界</h1><p>Hi <strong>there</strong>.</p></main></body></html>";
  const expected = "# Résumé & 🙂\n\n# Hello & 世界\n\nHi **there**.";
  assert.equal(await convertMd(html, "https://hussamfaroug.com"), expected);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
  try {
    const response = await worker.fetch(new Request("https://hussamfaroug.com/page", {
      headers: { Accept: "text/markdown" }
    }), testEnv);
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

test("HEAD requests use normal routes without a body", async () => {
  const originalFetch = globalThis.fetch;
  let fetchMethod;
  globalThis.fetch = async (_url, options) => {
    fetchMethod = options.method;
    return new Response(null, { status: 404, headers: { "Content-Type": "text/plain" } });
  };
  try {
    const missing = await worker.fetch(new Request("https://hussamfaroug.com/missing", {
      method: "HEAD"
    }), testEnv);
    assert.equal(fetchMethod, "GET");
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "");

  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstream fetch failures do not log request query parameters", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logs = [];
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const response = await worker.fetch(
      new Request("https://hussamfaroug.com/page?access_token=sensitive-value"),
      testEnv
    );
    assert.equal(response.status, 502);
    assert.deepEqual(logs, ["origin fetch failed"]);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("proxy uses configured origin, filters hop-by-hop headers, and preserves pass-through responses", async () => {
  const originalFetch = globalThis.fetch;
  let fetchUrl;
  let fetchHeaders;
  const expectedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed "));
      controller.enqueue(new TextEncoder().encode("body"));
      controller.close();
    }
  });
  globalThis.fetch = async (url, options) => {
    fetchUrl = url;
    fetchHeaders = options.headers;
    return new Response(expectedBody, {
      status: 206,
      headers: { "Content-Type": "application/octet-stream", "X-Origin": "kept" }
    });
  };
  try {
    const response = await worker.fetch(new Request("https://hussamfaroug.com/a/path?q=hello", {
      headers: {
        "Connection": "keep-alive",
        "Keep-Alive": "timeout=5",
        "TE": "trailers",
        "Trailer": "X-Checksum",
        "Upgrade": "websocket",
        "X-Forwarded-Test": "preserved"
      }
    }), testEnv);
    assert.equal(fetchUrl, "https://hgzvt98gtk-svg-github-io.pages.dev/a/path?q=hello");
    for (const header of ["connection", "keep-alive", "te", "trailer", "upgrade"]) {
      assert.equal(fetchHeaders.has(header), false);
    }
    assert.equal(fetchHeaders.get("x-forwarded-test"), "preserved");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("X-Origin"), "kept");
    assert.equal(await response.text(), "streamed body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxy returns a configuration error when its origin is missing", async () => {
  const response = await worker.fetch(new Request("https://hussamfaroug.com/page"), {});
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Origin configuration unavailable");
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
    const response = await worker.fetch(new Request("https://hussamfaroug.com/page"), testEnv);
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

test("HTML response transformation injects metadata and nonce script while streaming", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><head></head><body><p>Page</p></body></html>",
    { status: 201, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
  try {
    const response = await worker.fetch(new Request("https://hussamfaroug.com/page"), testEnv);
    const html = await response.text();
    assert.equal(response.status, 201);
    assert.match(html, /<link rel="agent" href="https:\/\/hussamfaroug\.com\/\.well-known\/agent-card\.json"/);
    assert.match(html, /<script nonce="[A-Za-z0-9_-]{32}">/);
    assert.match(response.headers.get("Content-Security-Policy"), /script-src 'self' 'nonce-[A-Za-z0-9_-]{32}'/);
    assert.match(html, /<p>Page<\/p>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Markdown conversion handles formatting, nested markup, links, and lists", async () => {
  const html = "<main><p><strong>Bold <span>text</span></strong> and <em>italic</em>, plus <b>bold</b> and <i>italic</i>.</p><ul><li><a href=\"/first\">First</a></li><li>Second</li></ul><ol><li>Third</li><li>Fourth</li></ol></main>";
  const expected = [
    "**Bold text** and *italic*, plus **bold** and *italic*.",
    "- [First](https://hussamfaroug.com/first)\n- Second",
    "1. Third\n2. Fourth"
  ].join("\n\n");

  assert.equal(await convertMd(html, "https://hussamfaroug.com"), expected);
});

test("Markdown conversion strips tags and escapes remaining angle brackets", async () => {
  const html = "<main><p><span>Nested text</span>: 2 < 3 &amp;&amp; 4 &gt; 1.</p><!-- removed -->unfinished <script</main>";
  assert.equal(
    await convertMd(html, "https://hussamfaroug.com"),
    "Nested text: 2 &lt; 3 && 4 &gt; 1.\nunfinished &lt;script"
  );
});

test("Markdown conversion preserves comparisons, quoted attributes, and encoded entities", async () => {
  const html = `<main title="main > content"><h1 title="heading > text">Heading</h1><p title='paragraph > text'>2 < 3 > 1 and &amp;lt;</p><pre>if (left < right) return 1;</pre></main>`;
  assert.equal(
    await convertMd(html, "https://hussamfaroug.com"),
    "# Heading\n\n2 &lt; 3 &gt; 1 and &lt;\n\n```\nif (left &lt; right) return 1;\n```"
  );
  assert.equal(
    await convertMd("<main><p><strong>&amp;lt;</strong> <code>&amp;lt;</code></p></main>", "https://hussamfaroug.com"),
    "**&lt;** `&lt;`"
  );
  assert.equal(
    await convertMd('<main><ul><li title="one > two">Item</li></ul></main>', "https://hussamfaroug.com"),
    "- Item"
  );
});

test("Markdown conversion removes unwanted nodes using HTML parsing", async (t) => {
  const cases = [
    {
      name: "nested elements and raw-text script/style content",
      html: '<main><nav><nav>hidden</nav>still hidden</nav><aside><footer>hidden</footer></aside><script><script>hidden</script></script><style><style>hidden</style></style><p>Visible</p></main>'
    },
    {
      name: "mixed case, quoted attributes, and closing-tag whitespace",
      html: `<main><ScRiPt data-value="> </script >" nonce='x'>hidden</sCrIpT \t\n><STYLE media='screen > print'>hidden</STYLE ><HEADER>hidden</HEADER ><NAV>hidden</NAV ><FOOTER>hidden</FOOTER ><ASIDE>hidden</ASIDE ><SVG><text>hidden</text></SVG ><META content=">"><LINK href='hidden >'><p>Visible</p></main>`
    },
    {
      name: "comment boundaries inside quoted tag attributes",
      html: `<main><script data-value="<!-- --> >">hidden</script><p title="<!-- --> >">Visible</p><!-- <main>hidden</main> --></main>`
    },
    {
      name: "HTML comment termination does not honor quotes",
      html: `<main><!-- <span title="-->"><script>hidden</script><p>Visible</p></main>`,
      expected: '"&gt;\n\nVisible'
    },
    {
      name: "unquoted attributes and malformed end-tag attributes",
      html: '<main><script src=/hidden defer>hidden</script ignored=">"><style media=screen>hidden</style ignored><p>Visible</p></main>'
    },
    {
      name: "script name assembled from source fragments",
      html: "<main><scr" + "ipt data-value='>'>hidden</scr" + "ipt ><p>Visible</p></main>"
    },
    {
      name: "main extraction ignores removed navigation and comments",
      html: "<html><head><title>Title</title><script>hidden</script></head><body><nav><main>hidden</main></nav><!-- <main>hidden</main> --><main><p>Visible</p></main><p>Outside</p></body></html>",
      expected: "# Title\n\nVisible"
    },
    {
      name: "article extraction remains intact",
      html: "<body><header>hidden</header><article><p>Visible</p></article><p>Outside</p></body>"
    },
    {
      name: "body extraction remains intact",
      html: "<html><head><style>hidden</style></head><body><p>Visible</p><footer>hidden</footer></body></html>"
    }
  ];
  for (const { name, html, expected = "Visible" } of cases) {
    await t.test(name, async () => {
      assert.equal(await convertMd(html, "https://hussamfaroug.com"), expected);
    });
  }
});

test("Markdown filtering cannot reconstruct tags across removed nodes", async () => {
  for (const removed of ["<!-- hidden -->", "<script>hidden</script>", "<style>hidden</style>"]) {
    const html = `<main><p><${removed}script>literal<${removed}/script></p></main>`;
    assert.equal(
      await convertMd(html, "https://hussamfaroug.com"),
      "&lt; script&gt;literal&lt; /script&gt;"
    );
  }
  assert.equal(
    await convertMd("<main><p>Before<!-- hidden -->after</p></main>", "https://hussamfaroug.com"),
    "Before after"
  );
});

test("HEAD responses preserve GET representation headers and omit the body", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMethods = [];
  globalThis.fetch = async (_url, options) => {
    fetchMethods.push(options.method);
    return new Response("<html><head></head><body><p>Page</p></body></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  };
  try {
    for (const accept of ["text/html", "text/markdown"]) {
      const getResponse = await worker.fetch(new Request("https://hussamfaroug.com/page", {
        headers: { Accept: accept }
      }), testEnv);
      const headResponse = await worker.fetch(new Request("https://hussamfaroug.com/page", {
        method: "HEAD",
        headers: { Accept: accept }
      }), testEnv);

      assert.equal(headResponse.status, getResponse.status);
      assert.equal(headResponse.headers.get("Content-Type"), getResponse.headers.get("Content-Type"));
      assert.equal(headResponse.headers.get("Vary"), getResponse.headers.get("Vary"));
      assert.equal(headResponse.headers.get("Link"), getResponse.headers.get("Link"));
      assert.equal(headResponse.headers.get("Content-Security-Policy") !== null, accept === "text/html");
      assert.equal(await headResponse.text(), "");
    }
    assert.deepEqual(fetchMethods, ["GET", "GET", "GET", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Markdown conversion handles larger HTML documents", async () => {
  const paragraphCount = 5000;
  const html = `<main>${"<p>large document</p>".repeat(paragraphCount)}</main>`;
  const expected = Array(paragraphCount).fill("large document").join("\n\n");

  assert.equal(await convertMd(html, "https://hussamfaroug.com"), expected);
});

test("Markdown preserves status, restrictive caching, variation, and safe representation headers", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("<main><p>Missing</p></main>", {
    status: 404,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Accept-Language",
      ETag: '"html-version"',
      "Content-Length": "35"
    }
  });
  try {
    const response = await worker.fetch(new Request("https://hussamfaroug.com/page", {
      headers: { Accept: "text/markdown" }
    }), testEnv);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("Vary"), "Cookie, Accept-Language, Accept");
    assert.equal(response.headers.has("ETag"), false);
    assert.equal(response.headers.has("Content-Length"), false);
    assert.equal(await response.text(), "Missing");
  } finally {
    globalThis.fetch = original;
  }
});

test("Markdown avoids shared caching for credentials or upstream cookies", async () => {
  const original = globalThis.fetch;
  try {
    for (const variant of ["Authorization", "Cookie", "Set-Cookie", "none"]) {
      globalThis.fetch = async () => new Response("<main>Content</main>", {
        headers: { "Content-Type": "text/html", ...(variant === "Set-Cookie" ? { "Set-Cookie": "session=test" } : {}) }
      });
      const response = await worker.fetch(new Request("https://hussamfaroug.com/page", {
        headers: { Accept: "text/markdown", ...(["Authorization", "Cookie"].includes(variant) ? { [variant]: "test" } : {}) }
      }), testEnv);
      assert.equal(response.headers.get("Cache-Control"), variant === "none" ? "no-store" : "private, no-store");
      await response.text();
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Markdown avoids shared caching for custom identity headers", async () => {
  const original = globalThis.fetch;
  try {
    for (const header of ["X-API-Key", "X-Auth-Token", "X-Access-Token", "Bearer", "X-Custom-Auth"]) {
      globalThis.fetch = async () => new Response("<main>Content</main>", {
        headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" }
      });
      const response = await worker.fetch(new Request("https://hussamfaroug.com/page", {
        headers: { Accept: "text/markdown", [header]: "test-value" }
      }), testEnv);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store", header);
      await response.text();
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Markdown handles oversized responses and body-read failures without leaking details", async () => {
  const original = globalThis.fetch;
  try {
    for (const oversized of [true, false]) {
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
          if (oversized) controller.enqueue(new Uint8Array(MAX_HTML_BYTES + 1));
          else controller.error(new Error("sensitive origin details"));
        }
      }), { headers: { "Content-Type": "text/html" } });
      const response = await worker.fetch(new Request("https://hussamfaroug.com/page", {
        headers: { Accept: "text/markdown" }
      }), testEnv);
      assert.equal(response.status, 502);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(await response.text(), "Origin conversion unavailable");
    }
  } finally {
    globalThis.fetch = original;
  }
});
