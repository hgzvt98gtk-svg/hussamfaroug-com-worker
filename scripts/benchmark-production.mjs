import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseServerTiming, statistics } from "./benchmark-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const TARGETS = [
  { name: "10kb", bytes: 10_000 },
  { name: "100kb", bytes: 100_000 },
  { name: "500kb", bytes: 500_000 }
];
const MAX_ORIGIN_BYTES = 1_048_576;
const options = { iterations: 20, warmups: 3, label: "manual", output: resolve(root, "benchmark-results/current.json") };

function parseArgs(args) {
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (!["--iterations", "--warmups", "--label", "--output"].includes(flag) || !value) {
      throw new Error("Usage: node scripts/benchmark-production.mjs [--iterations N] [--warmups N] [--label NAME] [--output PATH]");
    }
    if (flag === "--iterations" || flag === "--warmups") {
      const count = Number(value);
      const maximum = flag === "--iterations" ? 25 : 10;
      if (!Number.isInteger(count) || count < 1 || count > maximum) {
        throw new Error(`${flag} must be an integer between 1 and ${maximum}`);
      }
      options[flag.slice(2)] = count;
    } else {
      options[flag.slice(2)] = value;
    }
  }
}

function configuration() {
  const toml = readFileSync(resolve(root, "wrangler.toml"), "utf8");
  const origin = toml.match(/^\s*ORIGIN\s*=\s*"([^"]+)"/m)?.[1];
  const route = toml.match(/^\s*\{\s*pattern\s*=\s*"([^"]+)"/m)?.[1];
  if (!origin || !route) throw new Error("wrangler.toml must define vars.ORIGIN and a production route");
  const routeHost = route.split("/")[0];
  if (routeHost.includes("*")) throw new Error("The production route must identify one public hostname");
  const workerUrl = `https://${routeHost}`;
  const parsedOrigin = new URL(origin);
  const parsedWorker = new URL(workerUrl);
  if (!["https:", "http:"].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password) {
    throw new Error("wrangler.toml ORIGIN must be a public HTTP(S) URL");
  }
  return { origin: parsedOrigin, worker: parsedWorker };
}

const decoder = new TextDecoder();
function xmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code[0] === "#") {
      const number = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[code.toLowerCase()];
  });
}

async function readLimited(response, limit = MAX_ORIGIN_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(`Origin response exceeded the ${limit}-byte discovery limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sourceGet(url, accept) {
  return fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { accept },
    signal: AbortSignal.timeout(10_000)
  });
}

function sameOriginPath(value, origin, worker) {
  try {
    const url = new URL(value, origin);
    return [origin.origin, worker.origin].includes(url.origin) &&
      !url.username && !url.password && !url.search && !url.hash ? url.pathname : null;
  } catch {
    return null;
  }
}

async function sitemapPaths(origin, worker) {
  const sitemapUrl = new URL("/sitemap.xml", origin);
  const response = await sourceGet(sitemapUrl, "application/xml, text/xml;q=0.9, */*;q=0.1");
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return [];
  }
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("xml")) {
    await response.body?.cancel().catch(() => {});
    return [];
  }
  const xml = decoder.decode(await readLimited(response, 2_000_000));
  let locations = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map(match => xmlEntities(match[1].trim()));
  if (/<sitemapindex\b/i.test(xml)) {
    const childMaps = locations.slice(0, 5);
    locations = [];
    for (const location of childMaps) {
      const childPath = sameOriginPath(location, origin, worker);
      if (!childPath) continue;
      const child = await sourceGet(new URL(childPath, origin), "application/xml, text/xml;q=0.9, */*;q=0.1");
      if (child.status !== 200 || !(child.headers.get("content-type") || "").toLowerCase().includes("xml")) {
        await child.body?.cancel().catch(() => {});
        continue;
      }
      const body = decoder.decode(await readLimited(child, 2_000_000));
      locations.push(...[...body.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map(match => xmlEntities(match[1].trim())));
    }
  }
  return [...new Set(locations.map(location => sameOriginPath(location, origin, worker)).filter(Boolean))].slice(0, 50);
}

function linkedPaths(html, origin, worker) {
  const candidates = [];
  for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi)) {
    const path = sameOriginPath(match[1] || match[2] || match[3], origin, worker);
    if (path && !/\.(?:css|js|png|jpe?g|gif|svg|webp|ico|pdf|xml)(?:$|\?)/i.test(path)) candidates.push(path);
  }
  return [...new Set(candidates)];
}

async function originPage(path, origin) {
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) return null;
  const response = await sourceGet(url, "text/html, application/xhtml+xml;q=0.9");
  if (response.status !== 200 || !/(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  let bytes;
  try {
    bytes = await readLimited(response);
  } catch {
    return null;
  }
  return {
    path,
    sourceHtmlBytes: bytes.byteLength,
    sourceSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function discoverPages(origin, worker) {
  const paths = await sitemapPaths(origin, worker).catch(() => []);
  paths.unshift("/");
  const seen = new Set();
  const candidates = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const page = await originPage(path, origin).catch(() => null);
    if (page) candidates.push(page);
    if (candidates.length >= 50) break;
  }
  if (candidates.length < 3) {
    const home = candidates.find(page => page.path === "/") || await originPage("/", origin).catch(() => null);
    if (home) {
      const response = await sourceGet(new URL("/", origin), "text/html");
      if (response.status === 200) {
        const html = decoder.decode(await readLimited(response));
        for (const path of linkedPaths(html, origin, worker)) {
          if (seen.has(path)) continue;
          seen.add(path);
          const page = await originPage(path, origin).catch(() => null);
          if (page) candidates.push(page);
          if (candidates.length >= 50) break;
        }
      } else {
        await response.body?.cancel().catch(() => {});
      }
    }
  }
  if (candidates.length < 3) {
    throw new Error(`Found only ${candidates.length} eligible HTML page(s) at the configured origin; at least three distinct pages are needed. No HTML fixtures are injected.`);
  }
  let best;
  for (const first of candidates) for (const second of candidates) for (const third of candidates) {
    if (first.path === second.path || first.path === third.path || second.path === third.path) continue;
    const pages = [first, second, third];
    const score = pages.reduce((sum, page, index) =>
      sum + Math.abs(Math.log(Math.max(1, page.sourceHtmlBytes) / TARGETS[index].bytes)), 0);
    if (!best || score < best.score) best = { score, pages };
  }
  return TARGETS.map((target, index) => ({ ...target, ...best.pages[index] }));
}

async function requestMarkdown(worker, page, iteration, warmup) {
  const url = new URL(page.path, worker);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/markdown", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(30_000)
    });
    let responseBytes = null;
    let readError;
    try {
      responseBytes = (await readLimited(response, 5_000_000)).byteLength;
    } catch (error) {
      readError = error?.name || "response body read failed";
    }
    const totalMs = performance.now() - started;
    const ray = response.headers.get("cf-ray");
    const cacheStatus = response.headers.get("cf-cache-status");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || null;
    const tokenCount = response.headers.get("x-markdown-tokens");
    return {
      iteration,
      warmup,
      status: response.status,
      totalMs,
      responseBytes,
      serverTiming: parseServerTiming(response.headers.get("server-timing")),
      contentType,
      markdownTokens: tokenCount === null ? null : tokenCount,
      cfRay: ray,
      cfCacheStatus: cacheStatus,
      ...(!readError && response.status === 200 && contentType !== "text/markdown" ? { error: "unexpected content type" } : {}),
      ...(readError ? { error: readError } : {})
    };
  } catch (error) {
    return {
      iteration,
      warmup,
      status: null,
      totalMs: performance.now() - started,
      responseBytes: null,
      serverTiming: {},
      contentType: null,
      markdownTokens: null,
      cfRay: null,
      cfCacheStatus: null,
      error: error?.name || "request failed"
    };
  }
}

function summarizeFixture(page, samples, warmups) {
  const measured = samples.filter(sample => !sample.warmup);
  const statuses = measured.map(sample => sample.status);
  const stageNames = [...new Set(measured.flatMap(sample => Object.keys(sample.serverTiming)))];
  const serverTiming = Object.fromEntries(stageNames.map(stage => [
    stage, statistics(measured.map(sample => sample.serverTiming[stage]).filter(Number.isFinite))
  ]));
  return {
    name: page.name,
    targetHtmlBytes: page.bytes,
    path: page.path,
    sourceHtmlBytes: page.sourceHtmlBytes,
    sourceSha256: page.sourceSha256,
    iterations: measured.length,
    warmups,
    errors: samples.filter(sample => sample.status !== 200 || sample.error).length,
    statusCodes: [...new Set(samples.map(sample => sample.status === null ? "request-error" : String(sample.status)))],
    timings: {
      total: statistics(measured.map(sample => sample.totalMs)),
      responseBytes: statistics(measured.map(sample => sample.responseBytes).filter(Number.isFinite)),
      serverTiming
    },
    samples
  };
}

function printTable(fixtures) {
  console.table(fixtures.map(fixture => ({
    target: fixture.name,
    path: fixture.path,
    "source HTML bytes": fixture.sourceHtmlBytes,
    "total p50 ms": fixture.timings.total?.p50?.toFixed(2) ?? "n/a",
    "total p99 ms": fixture.timings.total?.p99?.toFixed(2) ?? "n/a",
    "conversion p50 ms": fixture.timings.serverTiming.conversion?.p50?.toFixed(2) ?? "not exposed",
    "conversion p99 ms": fixture.timings.serverTiming.conversion?.p99?.toFixed(2) ?? "not exposed",
    statuses: fixture.statusCodes.join(", ")
  })));
}

parseArgs(process.argv.slice(2));
const { origin, worker } = configuration();
const pages = await discoverPages(origin, worker);
const fixtures = [];
for (const page of pages) {
  const samples = [];
  for (let iteration = 1; iteration <= options.warmups; iteration++) {
    samples.push(await requestMarkdown(worker, page, iteration, true));
  }
  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    samples.push(await requestMarkdown(worker, page, iteration, false));
  }
  fixtures.push(summarizeFixture(page, samples, options.warmups));
}
const result = {
  schemaVersion: 1,
  type: "production-real-page-benchmark",
  timestamp: new Date().toISOString(),
  label: options.label,
  target: worker.origin,
  origin: origin.origin,
  iterations: options.iterations,
  warmups: options.warmups,
  unit: "ms",
  methodology: "Sequential, read-only GET requests with Accept: text/markdown. Three real HTML source pages selected closest to 10,000/100,000/500,000 bytes; custom fixtures cannot be injected through this proxy. Total latency includes public-network latency and full Markdown response read.",
  baselineAvailable: false,
  success: fixtures.every(fixture => fixture.errors === 0),
  fixtures
};
const output = resolve(root, options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
printTable(fixtures);
console.log(`\nJSON results: ${output}`);
