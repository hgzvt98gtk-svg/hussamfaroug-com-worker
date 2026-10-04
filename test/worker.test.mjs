import assert from "node:assert/strict";
import test from "node:test";
import { HTMLRewriter as WasmHTMLRewriter } from "html-rewriter-wasm";
import worker from "../hussamfaroug-com-worker.js";
import { botAuth } from "../bot-auth.js";
import { convertMd } from "../markdown.js";
import { MAX_HTML_BYTES } from "../proxy.js";
import MarkdownIt from "markdown-it";

const markdownParser = new MarkdownIt({ html: true });
// Do not let the renderer's own URL filter hide converter regressions.
markdownParser.validateLink = () => true;
const renderMarkdown = value => markdownParser.render(value);

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
    const nonce = html.match(/<script nonce="([A-Za-z0-9_-]{32})">/)[1];
    const csp = response.headers.get("Content-Security-Policy");
    assert.match(csp, new RegExp("default-src 'self'.*script-src 'self' 'nonce-" + nonce + "' https://challenges\\.cloudflare\\.com"));
    assert.match(html, /<p>Page<\/p>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTML response transformation preserves origin CSP and adds the injected script nonce", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><head></head><body><p>Page</p></body></html>",
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' https://trusted-cdn.example.com; object-src 'none'"
      }
    }
  );
  try {
    const response = await worker.fetch(new Request("https://hussamfaroug.com/page"), testEnv);
    const html = await response.text();
    const nonce = html.match(/<script nonce="([A-Za-z0-9_-]{32})">/)[1];
    const csp = response.headers.get("Content-Security-Policy");
    assert.match(csp, new RegExp("default-src 'self'; script-src 'self' https://trusted-cdn\\.example\\.com 'nonce-" + nonce + "' https://challenges\\.cloudflare\\.com; object-src 'none'"));
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

test("Markdown rejects unsupported, obfuscated, and malformed destinations", async () => {
  for (const destination of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java&#115;cript:alert(1)",
    "java&#x73;cript:alert(1)", "javascript&colon;alert(1)", "java&Tab;script:alert(1)",
    "java&NewLine;script:alert(1)", "java&#9script:alert(1)", "java\nscript:alert(1)",
    "&#106;&#97;vascript:alert(1)", "javascript&#x3a;alert(1)", "javascript&#58alert(1)",
    "vbscript:msgbox(1)", "data:text/html,unsafe", "file:///etc/passwd",
    "blob:https://site.example/id", "mailto:user@example.com", "tel:123", "ftp://site.example",
    "https://[invalid", "http://", "https://example.com:99999/", "javascript&amp;colon;alert(1)",
    "https://example.com/&unknown;", "https://example.com/&constructor;", "/literal&amp;#x3a;", "",
    "   ", "/path\u0000tail", "/path&#0;tail", "/path&#xD800;tail"
  ]) {
    assert.equal(await convertMd(`<main><a href="${destination}">Safe <b>label</b></a><img src="${destination}" alt="Safe alt"></main>`, "https://site.example/page"), "Safe labelSafe alt", destination);
  }
});

test("Markdown rejects mixed-encoding and URL-normalized malformed destinations", async () => {
  for (const destination of [
    "&#x6a;ava&#115;cript&colon;alert(1)", "java&#x73;cript&#58alert(1)",
    "java&#x09;script&colon;alert(1)", "java&NewLine;script&#x3a;alert(1)",
    "java&amp;#x73;cript&colon;alert(1)", "javascript&#xZZ;alert(1)",
    "https://%26colon;/", "https://%26%23106;/", "https://%EF%BF%BD/"
  ]) {
    const markdown = await convertMd(`<main><a href="${destination}">Safe label</a><img src="${destination}" alt="Safe alt"></main>`, "https://site.example/page");
    assert.equal(markdown, "Safe labelSafe alt", destination);
    assert.doesNotMatch(renderMarkdown(markdown), /<(?:a|img)\b/i, destination);
  }
});

test("Markdown destinations use parser attributes, URL normalization and delimiter encoding", async () => {
  const cases = [
    ["/relative?q=one&amp;two=2#part", "https://site.example/relative?q=one&two=2#part"],
    ["../路径?词=🙂#片", "https://site.example/%E8%B7%AF%E5%BE%84?%E8%AF%8D=%F0%9F%99%82#%E7%89%87"],
    ["#fragment", "https://site.example/dir/page#fragment"],
    ["HtTpS://EXAMPLE.com/path", "https://example.com/path"],
    ["http://example.com/path", "http://example.com/path"],
    ["//cdn.example/image.png", "https://cdn.example/image.png"],
    ["/a&#40;b&#41;&#91;c&#93; space", "https://site.example/a%28b%29\\[c\\]%20space"],
    ["/query?q=&quot;quoted&quot;&amp;x=1", "https://site.example/query?q=%22quoted%22&x=1"],
    ["https://[2001:db8::1]/?a=1&amp;b=2", "https://\\[2001:db8::1\\]/?a=1&b=2"],
    ["/back\\slash", "https://site.example/back/slash"],
    ["/?q=back\\slash[bracket]", "https://site.example/?q=back%5Cslash\\[bracket\\]"]
  ];
  for (const [destination, expected] of cases) {
    assert.equal(await convertMd(`<main><a data-href="javascript:bad" title="href='javascript:bad'" href="${destination}">世界 🙂</a><img src="${destination}" alt="图片"></main>`, "https://site.example/dir/page"),
      `[世界 🙂](${expected})![图片](${expected})`, destination);
  }
  assert.equal(await convertMd("<main><a HREF=/valid>Unquoted</a><IMG SRC=/pic ALT=Alt></main>", "https://site.example"), "[Unquoted](https://site.example/valid)![Alt](https://site.example/pic)");
  const markdown = await convertMd('<main><a href="https://[2001:db8::1]/?a=1&amp;b=2">Link</a></main>', "https://site.example");
  const destination = new URL(markdown.slice("[Link](".length, -1).replace(/\\([[\]])/g, "$1"));
  assert.equal(destination.hostname, "[2001:db8::1]");
  assert.deepEqual([...destination.searchParams], [["a", "1"], ["b", "2"]]);
});

test("Markdown preserves validated linked images without escaping their generated syntax", async () => {
  assert.equal(await convertMd('<main><a href="/target">Before <img src="/img.png" alt="x](bad)[y"> after</a></main>', "https://site.example"),
    "[Before ![x\\]\\(bad\\)\\[y](https://site.example/img.png) after](https://site.example/target)");
  assert.equal(await convertMd('<main><a href="/target"><img src="/img.png" alt="Image"></a></main>', "https://site.example"),
    "[![Image](https://site.example/img.png)](https://site.example/target)");
  assert.equal(await convertMd('<main><a href="javascript:bad"><img src="data:bad" alt="x](bad)[y"></a></main>', "https://site.example"), "x\\]\\(bad\\)\\[y");
});

test("Markdown labels and alt text cannot inject link syntax after entity decoding", async () => {
  const label = "click&#93;&#40;javascript:evil&#41;&#91;x\\ &amp;#93; &lt;tag&gt;";
  const expected = "click\\]\\(javascript:evil\\)\\[x\\\\ \\&\\#93; &lt;tag&gt;";
  const actual = await convertMd(`<main><a href="/safe">${label}</a><img src="/safe" alt="${label}"></main>`, "https://site.example");
  assert.equal(actual, `[${expected}](https://site.example/safe)![${expected}](https://site.example/safe)`);
  assert.equal(await convertMd('<main><a href="javascript:bad">x](data:bad)[y</a><img src="data:bad" alt="x](data:bad)[y"></main>', "https://site.example"), "x\\]\\(data:bad\\)\\[yx\\]\\(data:bad\\)\\[y");
  assert.equal(await convertMd('<main><a href="/safe">line&#10;break&#127;end</a></main>', "https://site.example"), "[line break end](https://site.example/safe)");
});

test("Markdown container cleanup cannot resurrect unsafe destinations", async () => {
  for (const tag of ["h2", "blockquote", "strong", "em", "li", "p", "span"]) {
    for (const label of [
      "<a href='javascript:bad'>run</a>)",
      "[<a>run</a>](javascript:bad)",
      "<a href='javascript:bad'>x](javascript:bad)[<a>run</a>)</a>",
      "<strong><a href='data:bad'>run</a>)</strong>",
      "&#91;run&#93;&#40;javascript&colon;bad&#41;",
      "[run](javascript:bad)", "\\[run](vbscript:bad)",
      "&#91;run&#93;&#40;java&#115;cript&colon;bad&#41;",
      "![run](java&#x73;cript&#58;bad)",
      "&amp;#91;run&amp;#93;(data:bad)"
    ]) {
      const content = `<${tag}>${label}</${tag}>`;
      const html = `<main>${tag === "li" ? `<ul>${content}</ul>` : content}</main>`;
      const markdown = await convertMd(html, "https://site.example/page");
      const rendered = renderMarkdown(markdown);
      assert.doesNotMatch(rendered, /<(?:a|img)\b/i, `${tag}: ${markdown}`);
      assert.match(rendered, /run/);
    }
  }
  const title = await convertMd("<title>[run](javascript:bad)</title><main>Text</main>", "https://site.example");
  assert.doesNotMatch(renderMarkdown(title), /<a\b/i);
  const formatted = await convertMd('<main><h2><strong>Bold</strong> <a href="/safe">safe</a></h2><blockquote><em>Italic</em></blockquote></main>', "https://site.example");
  assert.match(renderMarkdown(formatted), /<h2><strong>Bold<\/strong> <a href="https:\/\/site.example\/safe">safe<\/a><\/h2>/);
  assert.match(renderMarkdown(formatted), /<em>Italic<\/em>/);
});

test("rendered Markdown preserves validated destination semantics and linked images", async () => {
  const markdown = await convertMd('<main><a href="https://[2001:db8::1]/?a=1&amp;b=2"><img src="/路径?q=🙂" alt="x](javascript:bad)"></a></main>', "https://site.example");
  const rendered = renderMarkdown(markdown);
  assert.match(rendered, /href="https:\/\/\[2001:db8::1\]\/\?a=1&amp;b=2"/);
  assert.match(rendered, /src="https:\/\/site.example\/%E8%B7%AF%E5%BE%84\?q=%F0%9F%99%82"/);
  assert.equal((rendered.match(/<a\b/g) || []).length, 1);
  assert.equal((rendered.match(/<img\b/g) || []).length, 1);
});

test("Markdown escapes bare link syntax while preserving code and validated destinations", async () => {
  const payload = "[run](java&#115;cript&colon;bad)";
  const markdown = await convertMd(`<main>${payload}<p>![run](javascript:bad)</p><a href="/safe">safe</a><img src="/safe.png" alt="safe"></main>`, "https://site.example");
  const rendered = renderMarkdown(markdown);
  assert.equal((rendered.match(/<a\b/g) || []).length, 1);
  assert.equal((rendered.match(/<img\b/g) || []).length, 1);
  assert.match(rendered, /href="https:\/\/site.example\/safe"/);
  assert.match(rendered, /src="https:\/\/site.example\/safe.png"/);

  for (const [tag, text] of [
    ["code", "[run](javascript:bad)"], ["pre", "[run](javascript:bad)"],
    ["code", "`[run](javascript:bad)`"],
    ["code", "first\n\n[run](javascript:bad)"],
    ["code", "first\r\n\r\n![run](javascript:bad)"],
    ["pre", "```\n[run](javascript:bad)\n```"]
  ]) {
    const code = await convertMd(`<main><${tag}>${text}</${tag}></main>`, "https://site.example");
    const output = renderMarkdown(code);
    assert.doesNotMatch(output, /<(?:a|img)\b/i, `${tag}: ${code}`);
    assert.match(output, /<code>/);
    assert.ok(output.includes(tag === "pre" ? `${text}\n` : text.replace(/\r\n?|\n/g, " ")), output);
  }
  for (const tag of ["code", "pre"]) {
    const markdown = await convertMd(`<main><${tag}>before<img src="/image.png" alt="diagram">after</${tag}></main>`, "https://site.example");
    const text = "before![diagram](https://site.example/image.png)after";
    assert.equal(markdown, tag === "pre" ? `\`\`\`\n${text}\n\`\`\`` : `\`${text}\``);
    assert.doesNotMatch(renderMarkdown(markdown), /<(?:a|img)\b/i);
  }
  for (const html of [
    "`<code>[run](javascript:bad)</code>",
    "```\n<pre>[run](javascript:bad)</pre>",
    "<code>[run](javascript:bad)</code>`"
  ]) {
    const markdown = await convertMd(`<main>${html}</main>`, "https://site.example");
    assert.doesNotMatch(renderMarkdown(markdown), /<(?:a|img)\b/i, markdown);
  }
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

test("Markdown HEAD responses skip reading and converting the origin body", async () => {
  const originalFetch = globalThis.fetch;
  let pulls = 0;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode("<main><p>Page</p></main>"));
    },
    cancel() {
      cancelled = true;
    }
  }, { highWaterMark: 0 }), {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": "24",
      "Content-Encoding": "gzip",
      ETag: "\"html\"",
      "Cache-Control": "public, max-age=60"
    }
  });
  try {
    const response = await worker.fetch(new Request("https://hussamfaroug.com/page", {
      method: "HEAD",
      headers: { Accept: "text/markdown", "X-API-Key": "secret" }
    }), testEnv);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
    assert.equal(response.headers.get("Content-Length"), null);
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.equal(response.headers.get("ETag"), null);
    assert.equal(response.headers.get("x-markdown-tokens"), null);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.match(response.headers.get("Vary"), /Accept/);
    assert.equal(await response.text(), "");
    assert.ok(pulls <= 1);
    assert.equal(cancelled, true);
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

test("Markdown text slicing preserves long runs, comparisons, and incomplete tags", async () => {
  const text = "Résumé 世界 🙂 < 3 &amp; ".repeat(1000);
  const html = `<main><p>${text}<span title="quoted > delimiter">end</span>unfinished <tag</p></main>`;
  assert.equal(await convertMd(html, "https://site.example"), text.replaceAll("<", "&lt;").replaceAll("&amp;", "&") + "endunfinished &lt;tag");
});

test("Markdown shared patterns remain deterministic across concurrent conversions", async () => {
  const documents = Array.from({ length: 24 }, (_, index) => ({
    html: `<main><h2>Heading ${index}</h2><ul><li>One</li><li>Two</li></ul><p><a href="/${index}">Link</a> <strong>bold</strong></p></main>`,
    expected: `## Heading ${index}\n\n- One\n- Two\n\n[Link](https://site.example/${index}) **bold**`
  }));
  const output = await Promise.all(documents.map(({ html }) => convertMd(html, "https://site.example")));
  assert.deepEqual(output, documents.map(({ expected }) => expected));
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

test("identity cache policy covers GET/HEAD and every proxied representation", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    for (const method of ["GET", "HEAD"]) {
      for (const representation of ["html", "markdown", "json", "null"]) {
        for (const identity of ["X-aPi-KeY", "x-AuTh-ToKeN", "X-aCcEsS-ToKeN", "bEaReR", "x-CuStOm-AuTh", "aUtHoRiZaTiOn", "cOoKiE", "Set-Cookie", "none"]) {
          for (const cache of ["public, max-age=60, s-maxage=120", "private, max-age=0", null]) {
            const upstreamHeaders = {
              "Content-Type": representation === "json" ? "application/json" : "text/html",
              Vary: "Origin",
              "CDN-Cache-Control": "public, s-maxage=600",
              "Cloudflare-CDN-Cache-Control": "public, max-age=600",
              "Surrogate-Control": "max-age=600"
            };
            if (cache !== null) upstreamHeaders["Cache-Control"] = cache;
            if (identity === "Set-Cookie") upstreamHeaders["Set-Cookie"] = "session=credential-marker";
            globalThis.fetch = async (_url, options) => {
              if (["aUtHoRiZaTiOn", "cOoKiE"].includes(identity)) assert.equal(options.headers.has(identity), false);
              else if (!["none", "Set-Cookie"].includes(identity)) assert.equal(options.headers.get(identity), "credential-marker");
              return new Response(representation === "null" ? null : representation === "json" ? '{"ok":true}' : "<html><head></head><body><p>Content</p></body></html>", {
                status: representation === "null" ? 204 : 404, headers: upstreamHeaders
              });
            };
            const response = await worker.fetch(new Request("https://hussamfaroug.com/page", {
              method,
              headers: {
                Accept: representation === "markdown" ? "text/markdown" : "text/html",
                ...(!["none", "Set-Cookie"].includes(identity) ? { [identity]: "credential-marker" } : {})
              }
            }), testEnv);
            const expected = identity !== "none" ? "private, no-store" : cache ?? (representation === "markdown" ? "no-store" : null);
            assert.equal(response.headers.get("Cache-Control"), expected, `${method}/${representation}/${identity}/${cache}`);
            for (const name of ["CDN-Cache-Control", "Cloudflare-CDN-Cache-Control", "Surrogate-Control"]) {
              assert.equal(response.headers.get(name), identity === "none" ? upstreamHeaders[name] : "private, no-store");
            }
            assert.equal(response.status, representation === "null" ? 204 : 404);
            assert.equal(response.headers.get("Vary"), ["html", "markdown"].includes(representation) ? "Origin, Accept" : "Origin");
            const body = await response.text();
            if (method === "HEAD" || representation === "null") assert.equal(body, "");
            else if (representation === "markdown") assert.equal(body, "Content");
            else if (representation === "json") assert.equal(body, '{"ok":true}');
            else assert.match(body, /<p>Content<\/p>/);
          }
        }
      }
    }
    assert.deepEqual(logs, []);
    for (const path of ["/robots.txt", "/.well-known/api-catalog"]) {
      const response = await worker.fetch(new Request("https://hussamfaroug.com" + path, {
        headers: { "X-API-Key": "credential-marker" }
      }), testEnv);
      assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
      await response.text();
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("identity cache policy preserves non-HTML streaming and HEAD cancellation", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled;
  globalThis.fetch = async () => {
    cancelled = false;
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode("chunk")); },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 }), {
      status: 206, headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public" }
    });
  };
  try {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(new Request("https://hussamfaroug.com/file", {
        method, headers: { Cookie: "credential-marker" }
      }), testEnv);
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      if (method === "GET") {
        const reader = response.body.getReader();
        assert.equal(new TextDecoder().decode((await reader.read()).value), "chunk");
        await reader.cancel();
      } else assert.equal(response.body, null);
      assert.equal(cancelled, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTML media type classification is exact and case-insensitive for GET and HEAD", async () => {
  const originalFetch = globalThis.fetch;
  const html = "<html><head></head><body><p>Content</p></body></html>";
  try {
    for (const method of ["GET", "HEAD"]) {
      for (const accept of ["text/html", "text/markdown"]) {
        for (const [contentType, isHtml] of [
          ["text/html", true], ["Text/HTML; charset=UTF-8", true],
          ["  TEXT/HTML  ; charset=utf-8", true], ["text/html ; profile=\"example\"", true],
          ["application/text/html", false], ["text/htmlish", false], ["text/html-invalid", false],
          ["application/json; note=text/html", false], ["text/plain; text/html", false],
          ["text/html, application/json", false], [null, false]
        ]) {
          for (const nullBody of [false, true]) {
            globalThis.fetch = async () => {
              const headers = { Vary: "Origin" };
              if (contentType !== null) headers["Content-Type"] = contentType;
              // A byte body avoids Response adding an implicit text/plain Content-Type.
              return new Response(nullBody ? null : new TextEncoder().encode(html), {
                status: nullBody ? 204 : 202, headers
              });
            };
            const response = await worker.fetch(new Request("https://hussamfaroug.com/page", {
              method, headers: { Accept: accept }
            }), testEnv);
            const transformed = isHtml && !nullBody;
            assert.equal(response.status, nullBody ? 204 : 202);
            assert.equal(response.headers.get("Vary"), transformed ? "Origin, Accept" : "Origin");
            assert.equal(response.headers.has("Link"), transformed && accept === "text/html");
            assert.equal(response.headers.has("Content-Security-Policy"), transformed && accept === "text/html");
            assert.equal(response.headers.get("Content-Type"),
              transformed && accept === "text/markdown" ? "text/markdown; charset=utf-8" : contentType?.trim() ?? null);
            const body = await response.text();
            if (method === "HEAD" || nullBody) assert.equal(body, "");
            else if (!transformed) assert.equal(body, html);
            else if (accept === "text/markdown") assert.equal(body, "Content");
            else assert.match(body, /<script nonce=/);
          }
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
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
