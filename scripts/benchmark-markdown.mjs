import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { HTMLRewriter as WasmHTMLRewriter } from "html-rewriter-wasm";
import { convertMd } from "../markdown.js";
import { MAX_HTML_BYTES, prefersMarkdown, readHtml } from "../proxy.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = { iterations: 10, baseline: resolve(root, "benchmarks/results-baseline.json"), label: "current" };
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (!["--iterations", "--baseline", "--output", "--label"].includes(flag) || !value) {
    throw new Error("Usage: node scripts/benchmark-markdown.mjs [--iterations N] [--baseline PATH] [--output PATH] [--label NAME]");
  }
  options[flag.slice(2)] = flag === "--iterations" ? Number(value) : value;
}
if (!Number.isInteger(options.iterations) || options.iterations < 10) throw new Error("Use at least 10 iterations");

// Adapt the existing test dependency, not a substitute regex parser, to Workers' API.
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

function generateHtml(bytes, complex = false) {
  const prefix = "<html><head><title>Benchmark</title></head><body><main>";
  const suffix = "</main></body></html>";
  const unit = complex
    ? '<h2>Heading</h2><p><strong>Bold</strong> and <em>emphasis</em> <a href="/page?q=1">link</a></p><ul><li>Item</li></ul><pre><code>const n = 1;</code></pre>'
    : "<p>Simple benchmark content with words and whitespace.</p>";
  const available = bytes - prefix.length - suffix.length;
  return prefix + unit.repeat(Math.floor(available / unit.length)) + " ".repeat(available % unit.length) + suffix;
}

const scenarios = [
  { name: "small", html: generateHtml(10_000), accept: "text/markdown" },
  { name: "medium", html: generateHtml(100_000, true), accept: "text/markdown" },
  { name: "large", html: generateHtml(1_000_000), accept: "text/markdown" },
  { name: "nested", html: "<html><body><main>" + "<div><blockquote>".repeat(128) +
      generateHtml(50_000, true) + "</blockquote></div>".repeat(128) + "</main></body></html>", accept: "text/markdown" },
  { name: "longAccept", html: generateHtml(50_000, true),
    accept: Array.from({ length: 400 }, (_, i) => `application/x-${i};q=0.1`).join(",") + ",text/html;q=0.5,text/markdown" }
];
const encoder = new TextEncoder();
const stages = ["accept", "readHtml", "rewriter", "markdown", "tokens", "total"];
const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0], max: sorted.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p99: percentile(sorted, 0.99)
  };
}

async function run(scenario) {
  const timing = {};
  const started = performance.now();
  let mark = performance.now();
  if (!prefersMarkdown(scenario.accept)) throw new Error("Scenario must negotiate Markdown");
  timing.accept = performance.now() - mark;
  const bytes = encoder.encode(scenario.html);
  if (bytes.length > MAX_HTML_BYTES) throw new Error("Scenario exceeds the HTML limit");
  let offset = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset += 16_384));
    }
  }));
  mark = performance.now();
  const html = await readHtml(response);
  timing.readHtml = performance.now() - mark;
  const markdown = await convertMd(html, "https://origin.example/page", (stage, ms) => { timing[stage] = ms; });
  mark = performance.now();
  const tokens = Math.max(1, Math.ceil(encoder.encode(markdown).length / 4));
  timing.tokens = performance.now() - mark;
  timing.total = performance.now() - started;
  return { timing, tokens };
}

let baseline;
try {
  if (!options.output || resolve(options.output) !== resolve(options.baseline)) {
    baseline = JSON.parse(await readFile(resolve(options.baseline), "utf8"));
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const fingerprint = createHash("sha256");
for (const file of ["markdown.js", "proxy.js"]) fingerprint.update(await readFile(resolve(root, file)));
const results = {
  schemaVersion: 1, label: options.label, timestamp: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch,
    rewriter: "html-rewriter-wasm@0.4.1", sourceSha256: fingerprint.digest("hex") },
  methodology: "Local streamed conversion pipeline; 3 warmups; sequential runs; nearest-rank percentiles; excludes origin network and Worker response headers",
  iterations: options.iterations, unit: "ms", scenarios: []
};
if (baseline) results.baseline = {
  timestamp: baseline.timestamp, sourceSha256: baseline.environment?.sourceSha256, iterations: baseline.iterations
};
for (const scenario of scenarios) {
  for (let i = 0; i < 3; i++) await run(scenario);
  const samples = [];
  for (let i = 0; i < options.iterations; i++) samples.push(await run(scenario));
  const entry = {
    name: scenario.name, htmlBytes: encoder.encode(scenario.html).length,
    acceptBytes: encoder.encode(scenario.accept).length, tokens: samples[0].tokens,
    timings: Object.fromEntries(stages.map(stage => [stage, statistics(samples.map(sample => sample.timing[stage]))]))
  };
  const previous = baseline?.scenarios?.find(item => item.name === scenario.name);
  if (previous && previous.htmlBytes === entry.htmlBytes && previous.acceptBytes === entry.acceptBytes &&
      previous.tokens === entry.tokens && baseline.schemaVersion === results.schemaVersion) {
    entry.comparisonPercent = Object.fromEntries(stages.map(stage => [stage,
      Object.fromEntries(["mean", "p99"].map(stat => [stat, previous.timings[stage]?.[stat] > 0
        ? (entry.timings[stage][stat] / previous.timings[stage][stat] - 1) * 100 : null]))]));
  }
  results.scenarios.push(entry);
  console.log(`\n${entry.name}: ${entry.htmlBytes} HTML bytes, ${entry.acceptBytes} Accept bytes`);
  console.table(stages.map(stage => ({
    stage, ...Object.fromEntries(Object.entries(entry.timings[stage]).map(([key, value]) => [key, value.toFixed(3)])),
    "mean delta %": entry.comparisonPercent?.[stage].mean?.toFixed(2) ?? "n/a"
  })));
}
const stamp = results.timestamp.replace(/[-:]/g, "").replace("T", "-").replace(/\..*/, "");
const output = options.output ? resolve(options.output) : resolve(root, `benchmarks/results-${stamp}.json`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(results, null, 2) + "\n");
console.log(`\nResults: ${output}`);
