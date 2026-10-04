import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { HTMLRewriter as WasmHTMLRewriter } from "html-rewriter-wasm";
import { convertMd } from "../markdown.js";

const options = { iterations: 10 };
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (!["--iterations", "--baseline", "--output"].includes(flag) || !value) {
    throw new Error("Usage: node scripts/profile-markdown-generation.mjs [--iterations N] [--baseline PATH] [--output PATH]");
  }
  options[flag.slice(2)] = flag === "--iterations" ? Number(value) : value;
}
if (!Number.isInteger(options.iterations) || options.iterations < 3) throw new Error("Use at least 3 iterations");

// Use the same streaming HTMLRewriter adapter as the existing benchmark.
globalThis.HTMLRewriter = class {
  constructor() { this.handlers = []; }
  on(selector, handler) { this.handlers.push(["on", selector, handler]); return this; }
  onDocument(handler) { this.handlers.push(["onDocument", handler]); return this; }
  transform(response) {
    const handlers = this.handlers;
    return new Response(new ReadableStream({
      async start(controller) {
        const rewriter = new WasmHTMLRewriter(chunk => controller.enqueue(chunk.slice()));
        try {
          for (const [method, ...args] of handlers) rewriter[method](...args);
          for await (const chunk of response.body) await rewriter.write(chunk);
          await rewriter.end();
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          rewriter.free();
        }
      }
    }), response);
  }
};

function fixture(unit) {
  const prefix = "<html><head><title>Profile</title></head><body><main>";
  const suffix = "</main></body></html>";
  const available = 500_000 - prefix.length - suffix.length;
  return prefix + unit.repeat(Math.floor(available / unit.length)) + " ".repeat(available % unit.length) + suffix;
}
const fixtures = {
  complex: fixture('<h2>Heading</h2><p><strong>Bold</strong> and <em>emphasis</em> <a href="/page?q=1">link</a></p><ul><li>Item</li></ul><pre><code>const n = 1;</code></pre>'),
  containers: fixture('<h2><strong>Heading</strong> <a href="/heading">link</a></h2><blockquote><em>Quote</em> <a href="/quote">link</a></blockquote><ol><li><strong>Item</strong> <code>a</code><code>b</code></li></ol><p>Text &amp; prose.</p>')
};
const hash = value => createHash("sha256").update(value).digest("hex");
const statistics = values => ({
  mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  min: Math.min(...values), max: Math.max(...values)
});
const baseline = options.baseline ? JSON.parse(await readFile(resolve(options.baseline), "utf8")) : null;
const results = {
  schemaVersion: 1, timestamp: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch,
    rewriter: "html-rewriter-wasm@0.4.1", sourceSha256: hash(await readFile(new URL("../markdown.js", import.meta.url))) },
  methodology: "3 warmups; sequential conversions; inclusive pass timings (including replacement callbacks); total includes HTMLRewriter; milliseconds",
  iterations: options.iterations, scenarios: []
};
for (const [name, html] of Object.entries(fixtures)) {
  let expected;
  for (let i = 0; i < 3; i++) expected = await convertMd(html, "https://origin.example/page");
  const samples = [];
  for (let i = 0; i < options.iterations; i++) {
    const timing = {};
    const start = performance.now();
    const markdown = await convertMd(html, "https://origin.example/page",
      (stage, ms) => { timing[stage] = ms; }, (pass, ms) => { timing[pass] = ms; });
    timing.total = performance.now() - start;
    assert.equal(markdown, expected, "Instrumentation must not change output");
    samples.push(timing);
  }
  const entry = {
    name, htmlBytes: Buffer.byteLength(html), fixtureSha256: hash(html), outputSha256: hash(expected),
    timings: Object.fromEntries(Object.keys(samples[0]).map(stage => [stage, statistics(samples.map(sample => sample[stage]))]))
  };
  const previous = baseline?.scenarios.find(item => item.name === name);
  if (baseline) {
    assert.equal(baseline.schemaVersion, results.schemaVersion);
    assert.ok(previous, `Missing baseline scenario: ${name}`);
    assert.equal(previous.fixtureSha256, entry.fixtureSha256, "Baseline fixture must match");
    assert.equal(previous.outputSha256, entry.outputSha256, "Optimization must preserve output");
    entry.totalSpeedup = previous.timings.total.mean / entry.timings.total.mean;
    entry.markdownSpeedup = previous.timings.markdown.mean / entry.timings.markdown.mean;
  }
  results.scenarios.push(entry);
  console.log(`\n${name}: ${entry.htmlBytes} bytes`);
  console.table(Object.entries(entry.timings).map(([stage, stats]) => ({
    stage, ...Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, value.toFixed(3)]))
  })));
  if (previous) console.log(`Total speedup: ${entry.totalSpeedup.toFixed(2)}x; Markdown speedup: ${entry.markdownSpeedup.toFixed(2)}x`);
}
if (options.output) await writeFile(resolve(options.output), JSON.stringify(results, null, 2) + "\n");
