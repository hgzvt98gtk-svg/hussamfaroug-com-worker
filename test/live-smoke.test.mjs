import assert from "node:assert/strict";
import test from "node:test";
import { checkResponse, IDENTITY_HEADERS, networkFailure, RETIRED_PATHS, runSmoke } from "../scripts/live-smoke.mjs";
import { isLegacyDiscoveryPath } from "../metadata.js";

function reply(url, options) {
  const path = new URL(url).pathname;
  const identity = Boolean(options.headers.authorization);
  const retired = RETIRED_PATHS.includes(path);
  const headers = new Headers({
    "content-type": path === "/" ? options.headers.accept : path === "/auth.md" ? "text/markdown" :
      path === "/favicon.ico" ? "image/x-icon" : "text/plain",
    "cache-control": retired ? "no-store" : identity && ["/", "/favicon.ico"].includes(path) ?
      "private, no-store" : "public, max-age=3600"
  });
  if (path === "/") headers.set("vary", "Accept");
  if (identity && ["/", "/favicon.ico"].includes(path)) headers.set("cdn-cache-control", "private, no-store");
  const text = path === "/auth.md" ?
    "Public, read-only. No credentials or bearer tokens are required. There is no credential registration, OAuth authorization server, OpenID Connect provider. It is not an HTTP service. The directory does not grant access or authenticate visitors." :
    path === "/" && options.headers.accept === "text/markdown" ? "# Site" : "site";
  return new Response(options.method === "HEAD" ? null : text, { status: retired ? 404 : 200, headers });
}

test("fixed target checks are sequential, read-only, grouped dummy identities and no redirects", async () => {
  let active = 0;
  const requests = [];
  const report = await runSmoke({
    fetchImpl: async (url, options) => {
      assert.equal(++active, 1);
      assert.equal(new URL(url).origin, "https://hussamfaroug.com");
      assert.ok(["GET", "HEAD"].includes(options.method));
      assert.equal(options.redirect, "manual");
      assert.ok(options.signal instanceof AbortSignal);
      requests.push({ url, options });
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return reply(url, options);
    }
  });
  assert.equal(report.ok, true);
  assert.equal(report.counts.httpResponses, 28);
  assert.equal(report.counts.attempted, 28);
  assert.equal(report.counts.skipped, 0);
  assert.equal(report.timingSamples.length, 3);
  assert.equal(report.staticCoverage, "verified favicon.ico");
  const root = requests.filter(item => new URL(item.url).pathname === "/");
  for (const type of ["text/html", "text/markdown"]) {
    for (const method of ["GET", "HEAD"]) {
      for (const identity of [false, true]) {
        assert.ok(root.some(item => item.options.method === method && item.options.headers.accept === type &&
          Boolean(item.options.headers.authorization) === identity));
      }
    }
  }
  assert.equal(Object.keys(IDENTITY_HEADERS).length, 7);
  for (const request of requests.filter(item => item.options.headers.authorization)) {
    for (const [key, value] of Object.entries(IDENTITY_HEADERS)) assert.equal(request.options.headers[key], value);
  }
  assert.ok(RETIRED_PATHS.every(isLegacyDiscoveryPath));
});

test("DNS failures are not HTTP responses or timing samples and trigger bounded fixed diagnostics", async () => {
  const error = Object.assign(new Error("sensitive message must not be printed"), { code: "ENOTFOUND" });
  const urls = [];
  const report = await runSmoke({
    fetchImpl: async url => {
      urls.push(url);
      throw new TypeError("fetch failed", { cause: error });
    },
    dns: { lookup: async () => { throw error; }, resolve4: async () => { throw error; } }
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.counts, { attempted: 1, httpResponses: 0, dnsErrors: 1, transportErrors: 0, bodyErrors: 0, skipped: 27 });
  assert.equal(report.timingSamples.length, 0);
  assert.equal(report.diagnostics.length, 4);
  assert.deepEqual(urls, [
    "https://hussamfaroug.com/",
    "https://dns.google/resolve?name=hussamfaroug.com&type=A",
    "https://example.com/"
  ]);
  assert.equal(JSON.stringify(report).includes("sensitive"), false);
});

test("HTTP errors remain responses, not DNS failures or successful timing samples", async () => {
  const report = await runSmoke({
    fetchImpl: async () => new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } })
  });
  assert.equal(report.ok, false);
  assert.equal(report.counts.httpResponses, 26);
  assert.equal(report.counts.dnsErrors, 0);
  assert.equal(report.counts.transportErrors, 0);
  assert.equal(report.counts.skipped, 2);
  assert.equal(report.timingSamples.length, 0);
  assert.equal(report.diagnostics.length, 0);
});

test("copied CDN headers require both private and no-store; public metadata is exempt", () => {
  const response = new Response(null, { headers: {
    "cache-control": "private, no-store", "cdn-cache-control": "public, max-age=900",
    "cloudflare-cdn-cache-control": "no-store", "surrogate-control": "private, no-store"
  } });
  assert.deepEqual(checkResponse({ identity: true }, response, ""), [
    "cdn-cache-control was copied without private, no-store",
    "cloudflare-cdn-cache-control was copied without private, no-store"
  ]);
  assert.deepEqual(checkResponse({ identity: true, publicMetadata: true }, response, ""), []);
});

test("HEAD, retired paths, content type and auth documentation are validated", () => {
  assert.ok(checkResponse({ method: "HEAD" }, new Response(), "body").includes("HEAD returned a body"));
  assert.equal(checkResponse({ retired: true }, new Response(), "").length, 2);
  assert.equal(checkResponse({ auth: true }, new Response(), "register here").length, 5);
  assert.ok(checkResponse({ type: "text/markdown", root: true }, new Response(), "").length >= 2);
});

test("body failures count the received HTTP response but never time incomplete bodies", async () => {
  const report = await runSmoke({
    fetchImpl: async (url, options) => {
      if (url === "https://hussamfaroug.com/" && options.method === "GET") {
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error("body failed")); } }));
      }
      return reply(url, options);
    }
  });
  assert.equal(report.counts.httpResponses, 28);
  assert.equal(report.counts.bodyErrors, 5);
  assert.equal(report.counts.dnsErrors, 0);
  assert.equal(report.timingSamples.length, 0);
  assert.equal(report.ok, false);
});

test("nested aggregate errors are classified without exposing messages", () => {
  assert.deepEqual(networkFailure(new AggregateError([
    Object.assign(new Error("private"), { code: "EAI_AGAIN" }),
    Object.assign(new Error("private"), { code: "ECONNREFUSED" })
  ])), { kind: "dns", codes: ["EAI_AGAIN", "ECONNREFUSED"] });
});
