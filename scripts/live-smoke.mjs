import { lookup, resolve4 } from "node:dns/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { validateAuthMetadataChain } from "./auth-metadata.mjs";

const ORIGIN = "https://hussamfaroug.com";
const TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 1024 * 1024;
export const IDENTITY_HEADERS = Object.freeze({
  authorization: "live-smoke-dummy",
  cookie: "live_smoke=dummy",
  "x-api-key": "live-smoke-dummy",
  "x-auth-token": "live-smoke-dummy",
  "x-access-token": "live-smoke-dummy",
  bearer: "live-smoke-dummy",
  "x-custom-auth": "live-smoke-dummy"
});
// These are the retired route families handled by metadata.js/discovery.js.
export const RETIRED_PATHS = Object.freeze([
  "/.well-known/mcp",
  "/.well-known/mcp.json",
  "/.well-known/agent.json",
  "/a2a", "/mcp", "/oauth", "/token",
  "/agent/auth", "/agent/revoke", "/agent/claims"
]);
export const DISCOVERY_PATHS = Object.freeze([
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/mcp/server-card.json"
]);
const CACHE_HEADERS = [
  "cache-control", "cdn-cache-control", "cloudflare-cdn-cache-control", "surrogate-control"
];

export function networkFailure(error) {
  const codes = [];
  const visit = value => {
    if (!value || codes.length >= 16) return;
    if (typeof value.code === "string") codes.push(value.code);
    if (value.name === "TimeoutError" || value.name === "AbortError") codes.push(value.name);
    if (value.cause) visit(value.cause);
    if (Array.isArray(value.errors)) value.errors.forEach(visit);
  };
  visit(error);
  // Only error codes, never messages, environment, credentials or response bodies.
  return {
    kind: codes.some(code => ["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL", "EREFUSED"].includes(code))
      ? "dns" : "transport",
    codes: [...new Set(codes)].filter(code => /^[A-Za-z0-9_]+$/.test(code))
  };
}

async function bodyText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error("body limit"), { code: "BODY_LIMIT" });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function privateNoStore(value) {
  const directives = (value || "").toLowerCase().split(",").map(part => part.trim());
  return directives.includes("private") && directives.includes("no-store");
}

export function checkResponse(spec, response, text) {
  const issues = [];
  const status = spec.retired ? 404 : 200;
  if (response.status !== status) issues.push(`expected status ${status}, received ${response.status}`);
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (spec.type && type !== spec.type) issues.push(`expected media type ${spec.type}, received ${type || "(missing)"}`);
  if (spec.nonHtml && (!type || type === "text/html" || type === "text/markdown")) {
    issues.push("static resource is not a verified non-HTML representation");
  }
  if (spec.method === "HEAD" && text !== "") issues.push("HEAD returned a body");
  if (spec.root) {
    const vary = (response.headers.get("vary") || "").toLowerCase().split(",").map(part => part.trim());
    if (!vary.includes("accept") && !vary.includes("*")) issues.push("missing Vary: Accept");
  }
  if (spec.identity && !spec.publicMetadata) {
    if (!privateNoStore(response.headers.get("cache-control"))) issues.push("identity response lacks Cache-Control: private, no-store");
    for (const header of CACHE_HEADERS.slice(1)) {
      if (response.headers.has(header) && !privateNoStore(response.headers.get(header))) {
        issues.push(`${header} was copied without private, no-store`);
      }
    }
  }
  if (spec.retired && !(response.headers.get("cache-control") || "").toLowerCase().split(",").some(part => part.trim() === "no-store")) {
    issues.push("retired route lacks no-store");
  }
  if (spec.auth && response.status === 200) {
    for (const phrase of [
      /public, read-only/i, /no credentials or bearer tokens are required/i,
      /discovery and manual-registration metadata only/i,
      /not an HTTP service/i, /does not grant access or authenticate visitors/i
    ]) {
      if (!phrase.test(text)) issues.push(`auth.md is missing descriptive statement ${phrase.source}`);
    }
  }
  if (spec.discovery && response.status === 200) {
    if (response.headers.get("cache-control") !== "public, max-age=3600") issues.push("discovery metadata lacks public one-hour caching");
    if (response.headers.get("access-control-allow-origin") !== "*") issues.push("discovery metadata lacks public CORS");
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) issues.push("discovery metadata is not a JSON object");
    } catch {
      issues.push("discovery metadata is not valid JSON");
    }
  }
  return issues;
}

async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "DIAGNOSTIC_TIMEOUT" })), TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function diagnoseNetwork(fetchImpl = fetch, dns = { lookup, resolve4 }) {
  const evidence = [];
  for (const [name, operation] of [
    ["system-lookup-site", () => dns.lookup("hussamfaroug.com", { all: true })],
    ["resolver-A-site", () => dns.resolve4("hussamfaroug.com")]
  ]) {
    try {
      const answers = await bounded(operation);
      evidence.push({ check: name, ok: true, answerCount: answers.length });
    } catch (error) {
      evidence.push({ check: name, ok: false, ...networkFailure(error) });
    }
  }
  for (const [name, url, method] of [
    ["dns-over-https-site", "https://dns.google/resolve?name=hussamfaroug.com&type=A", "GET"],
    ["known-host-https", "https://example.com/", "HEAD"]
  ]) {
    try {
      const response = await fetchImpl(url, {
        method, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: name === "dns-over-https-site" ? "application/dns-json" : "text/html" }
      });
      const item = { check: name, ok: response.ok, httpStatus: response.status };
      if (name === "dns-over-https-site" && response.ok) {
        const data = JSON.parse(await bodyText(response));
        item.dnsStatus = data.Status;
        item.answerCount = Array.isArray(data.Answer) ? data.Answer.length : 0;
      } else if (response.body) {
        await response.body.cancel();
      }
      evidence.push(item);
    } catch (error) {
      evidence.push({ check: name, ok: false, ...networkFailure(error) });
    }
  }
  return evidence;
}

export async function runSmoke({ fetchImpl = fetch, dns = { lookup, resolve4 } } = {}) {
  const report = {
    target: ORIGIN,
    deployment: "Observations describe the currently deployed site, not un-deployed local changes. Differences may indicate an older deployment; they do not identify its commit.",
    limitations: [
      "GET/HEAD only; sequential, fixed HTTPS destinations; redirects are never followed; no real credentials.",
      "All seven identity headers are grouped on each identity request: this checks their combined effect, not each header in isolation.",
      "robots.txt is worker-generated public metadata, an explicit exception to identity cache isolation; favicon.ico is only counted as static coverage if verified non-HTML.",
      "CDN cache isolation is checked only when CDN-Cache-Control, Cloudflare-CDN-Cache-Control or Surrogate-Control is present; missing headers cannot prove upstream behavior.",
      "Retired route checks cover exact representative paths, not every descendant or method.",
      "At most three successful anonymous root GET samples measure client-observed headers-plus-body wall time, not Worker CPU. No CPU, p95, cache-hit or before/after performance conclusion is possible.",
      "The first transport/DNS failure stops remaining site checks; diagnostic HTTP responses are counted separately."
    ],
    counts: { attempted: 0, httpResponses: 0, dnsErrors: 0, transportErrors: 0, bodyErrors: 0, skipped: 0 },
    checks: [],
    metadataChain: { ok: false, skipped: false, issues: [] },
    timingSamples: [],
    diagnostics: []
  };
  const specs = [];
  for (const type of ["text/html", "text/markdown"]) {
    for (const identity of [false, true]) {
      for (const method of ["GET", "HEAD"]) {
        specs.push({ path: "/", type, identity, method, root: true });
      }
    }
  }
  specs.push(
    { path: "/", type: "text/html", method: "GET", root: true },
    { path: "/robots.txt", type: "text/plain", method: "GET", publicMetadata: true },
    { path: "/robots.txt", type: "text/plain", method: "HEAD", identity: true, publicMetadata: true },
    { path: "/auth.md", type: "text/markdown", method: "GET", auth: true, publicMetadata: true },
    ...DISCOVERY_PATHS.map(path => ({ path, type: "application/json", method: "GET", discovery: true, publicMetadata: true })),
    ...RETIRED_PATHS.map(path => ({ path, method: "GET", retired: true }))
  );
  // A fixed static candidate avoids fetching arbitrary URLs from deployed HTML.
  specs.push(
    { path: "/favicon.ico", method: "GET", nonHtml: true, staticProbe: true },
    { path: "/favicon.ico", method: "GET", nonHtml: true, identity: true },
    { path: "/favicon.ico", method: "HEAD", nonHtml: true, identity: true }
  );
  let staticVerified = false;
  let anonymousMarkdown;
  const metadata = {};
  let failedNetwork = false;
  for (const spec of specs) {
    if (failedNetwork || (spec.nonHtml && !spec.staticProbe && !staticVerified)) {
      report.counts.skipped++;
      continue;
    }
    const item = { path: spec.path, method: spec.method, accept: spec.type || "*/*", identity: Boolean(spec.identity), issues: [] };
    report.counts.attempted++;
    const start = performance.now();
    let response;
    try {
      response = await fetchImpl(ORIGIN + spec.path, {
        method: spec.method, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: item.accept, ...(spec.identity ? IDENTITY_HEADERS : {}) }
      });
    } catch (error) {
      const failure = networkFailure(error);
      report.counts[failure.kind === "dns" ? "dnsErrors" : "transportErrors"]++;
      item.networkError = failure;
      failedNetwork = true;
      report.checks.push(item);
      continue;
    }
    report.counts.httpResponses++;
    item.status = response.status;
    item.headers = Object.fromEntries(
      ["content-type", "vary", ...CACHE_HEADERS].filter(header => response.headers.has(header))
        .map(header => [header, response.headers.get(header)])
    );
    try {
      const text = await bodyText(response);
      item.issues = checkResponse(spec, response, text);
      if (spec.path === "/.well-known/oauth-protected-resource" ||
          spec.path === "/.well-known/oauth-authorization-server") {
        try {
          metadata[spec.path] = JSON.parse(text);
        } catch {
          // checkResponse records the invalid JSON response.
        }
      } else if (spec.path === "/auth.md") {
        metadata[spec.path] = text;
      }
      if (spec.root && spec.method === "GET" && !spec.identity && response.ok) {
        report.timingSamples.push({ accept: item.accept, milliseconds: Math.round((performance.now() - start) * 10) / 10 });
      }
      if (spec.root && spec.type === "text/markdown" && spec.method === "GET" && response.status === 200) {
        if (spec.identity && anonymousMarkdown !== undefined && text !== anonymousMarkdown) {
          item.issues.push("dummy identity Markdown differs from anonymous Markdown (dynamic origin content may also cause this)");
        } else if (!spec.identity) anonymousMarkdown = text;
      }
      if (spec.staticProbe) staticVerified = item.issues.length === 0;
    } catch (error) {
      report.counts.bodyErrors++;
      item.bodyError = networkFailure(error);
      item.issues.push("HTTP response received, but body could not be completed");
    }
    report.checks.push(item);
  }
  if (failedNetwork) {
    report.metadataChain.skipped = true;
  } else {
    report.metadataChain.issues = validateAuthMetadataChain({
      origin: ORIGIN,
      protectedResource: metadata["/.well-known/oauth-protected-resource"],
      authorizationServer: metadata["/.well-known/oauth-authorization-server"],
      authMarkdown: metadata["/auth.md"]
    });
    report.metadataChain.ok = report.metadataChain.issues.length === 0;
  }
  if (failedNetwork) report.diagnostics = await diagnoseNetwork(fetchImpl, dns);
  report.staticCoverage = staticVerified ? "verified favicon.ico" : "unverified; static identity checks skipped";
  report.diagnosticHttpResponses = report.diagnostics.filter(item => item.httpStatus !== undefined).length;
  report.ok = !failedNetwork && report.counts.bodyErrors === 0 &&
    report.checks.every(item => item.issues.length === 0) && report.metadataChain.ok;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error("Usage: node scripts/live-smoke.mjs (fixed target; no arguments)");
    process.exitCode = 2;
  } else {
    try {
      const report = await runSmoke();
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      console.error(JSON.stringify({ error: networkFailure(error) }));
      process.exitCode = 1;
    }
  }
}
