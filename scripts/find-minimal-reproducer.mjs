import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { HTMLRewriter as WasmHTMLRewriter } from "html-rewriter-wasm";
import { convertMd, getMdDecStats, resetMdDecStats } from "../markdown.js";

const scriptPath = fileURLToPath(import.meta.url);
const defaultTimeoutMs = 15_000;
const timeoutMs = Number(process.env.PROFILE_TIMEOUT_MS || defaultTimeoutMs);
const knownSizes = [25_000, 50_000, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000];
const names = ["complex", "unclosed-headings", "special-links", "unclosed-format", "unclosed-title"];

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

function fixture(name, size) {
  const prefix = name === "unclosed-title"
    ? "<html><head><title>Unclosed title "
    : "<html><head><title>Fixture</title></head><body><main>";
  const suffix = name === "unclosed-title"
    ? "</head><body><main></main></body></html>"
    : "</main></body></html>";
  const units = {
    complex: "<div><blockquote>",
    "unclosed-headings": "<h2>Unclosed heading ",
    "special-links": '<a href="/page?q=a&amp;b=c">Special link</a>',
    "unclosed-format": "<strong>Unclosed formatting ",
    "unclosed-title": "Unclosed title content "
  };
  let open = "";
  let close = "";
  let bodyUnit = units[name];
  if (name === "complex") {
    open = units.complex.repeat(128);
    close = "</blockquote></div>".repeat(128);
    bodyUnit = '<p>Text <strong>bold</strong>, <em>emphasis</em>, and <code>x &amp; y</code>.</p>';
  }
  const fixed = prefix.length + open.length + close.length + suffix.length;
  const available = Math.max(0, size - fixed);
  const body = bodyUnit.repeat(Math.floor(available / bodyUnit.length)) +
    "x".repeat(available % bodyUnit.length);
  let html = prefix + open + body + close + suffix;
  if (html.length > size) html = html.slice(0, size);
  return html;
}

async function runChild(name, size, collectStats = false) {
  if (process.argv[2] === "--child") {
    const childName = process.argv[3];
    const childSize = Number(process.argv[4]);
    const childStats = process.argv[5] === "stats";
    const html = fixture(childName, childSize);
    await convertMd(fixture(childName, Math.min(childSize, 25_000)), "https://example.com");
    if (childStats) resetMdDecStats();
    const startedAt = performance.now();
    const markdown = await convertMd(html, "https://example.com");
    const elapsedMs = performance.now() - startedAt;
    process.stdout.write(JSON.stringify({
      inputChars: html.length,
      elapsedMs,
      outputChars: markdown.length,
      mdDec: childStats ? getMdDecStats() : undefined
    }));
    return;
  }

  const result = spawnSync(process.execPath, [
    scriptPath, "--child", name, String(size), collectStats ? "stats" : "plain"
  ], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    return { status: "TIMEOUT", timeoutMs };
  }
  if (result.status !== 0) {
    return { status: "ERROR", error: result.stderr.trim() || result.error?.message || `exit ${result.status}` };
  }
  try {
    return { status: "OK", ...JSON.parse(result.stdout) };
  } catch {
    return { status: "ERROR", error: `Invalid child output: ${result.stdout.slice(0, 200)}` };
  }
}

async function findExactThreshold(name, observations) {
  const timeoutAt = observations.findIndex(result => result.status === "TIMEOUT");
  if (timeoutAt <= 0) return null;
  let low = knownSizes[timeoutAt - 1];
  let high = knownSizes[timeoutAt];
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const result = await runChild(name, middle);
    if (result.status === "TIMEOUT") high = middle;
    else if (result.status === "OK") low = middle;
    else return { status: "ERROR", size: middle, detail: result.error };
  }
  return { lastPassingBytes: low, firstTimeoutBytes: high };
}

if (process.argv[2] === "--child") {
  await runChild();
} else {
  console.log(`Minimal-reproducer search (${process.version}; timeout=${timeoutMs}ms per isolated run)`);
  const results = [];
  for (const name of names) {
    const observations = [];
    for (const size of knownSizes) {
      const result = await runChild(name, size);
      observations.push(result);
      results.push({ fixture: name, bytes: size, status: result.status, elapsedMs: result.elapsedMs });
      if (result.status === "ERROR") console.error(`  ${name} ${size}: ${result.error}`);
    }
    const threshold = await findExactThreshold(name, observations);
    console.log(`\n${name}: ${threshold ? JSON.stringify(threshold) : "no timeout observed in tested sizes"}`);
  }
  console.table(results.map(result => ({
    fixture: result.fixture,
    bytes: result.bytes,
    status: result.status,
    "conversion ms": result.elapsedMs?.toFixed(3) ?? (result.status === "TIMEOUT" ? `>${timeoutMs}` : "—")
  })));

  const profileSize = 500_000;
  const profile = await runChild("complex", profileSize, true);
  console.log(`\n500 KB complex mdDec profile:`);
  if (profile.status !== "OK") {
    console.log(JSON.stringify(profile));
  } else {
    const stats = profile.mdDec;
    const distribution = {
      small: stats.callsBySize.filter(call => call.size < 100).length,
      medium: stats.callsBySize.filter(call => call.size >= 100 && call.size <= 1000).length,
      large: stats.callsBySize.filter(call => call.size > 1000).length
    };
    console.log(JSON.stringify({
      conversionMs: profile.elapsedMs,
      callCount: stats.callCount,
      totalMdDecMs: stats.totalTime,
      averageMs: stats.callCount ? stats.totalTime / stats.callCount : 0,
      maxMs: stats.maxTime,
      percentOfConversion: profile.elapsedMs ? stats.totalTime / profile.elapsedMs * 100 : 0,
      distribution
    }, null, 2));
  }
}
