import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import worker from "../hussamfaroug-com-worker.js";
import { fetchOriginWithRetry, ORIGIN_RETRY_BASE_DELAY_MS } from "../proxy.js";
import { checkRateLimit, RATE_LIMIT_MAX_CLIENTS, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS, resetRateLimits } from "../rate-limit.js";
import { getDirectiveIndex, getDirectiveSources, mergeWorkerScriptSources, parseCSPDirectives, secHdrs, setDirectiveSources } from "../response.js";
import { getMetrics } from "../metrics.js";

const env = { ORIGIN: "https://origin.example" };

beforeEach(() => resetRateLimits());

function withFetch(t, implementation) {
  t.mock.method(globalThis, "fetch", implementation);
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
}

test("rate limiter allows 100 requests per window, then rejects", () => {
  const now = 1000;
  for (let i = 0; i < RATE_LIMIT_REQUESTS; i++) assert.equal(checkRateLimit("1.1.1.1", now), true);
  assert.equal(checkRateLimit("1.1.1.1", now), false);
  assert.equal(checkRateLimit("1.1.1.1", now + RATE_LIMIT_WINDOW_MS), false);
  assert.equal(checkRateLimit("1.1.1.1", now + RATE_LIMIT_WINDOW_MS + 1), true);
});

test("rate limiter isolates clients, including the unknown fallback", () => {
  for (let i = 0; i < RATE_LIMIT_REQUESTS; i++) checkRateLimit("unknown", 0);
  assert.equal(checkRateLimit("unknown", 0), false);
  assert.equal(checkRateLimit("2.2.2.2", 0), true);
  assert.equal(checkRateLimit("2001:db8::1", 0), true);
});

test("rate limiter memory stays bounded under many distinct clients", () => {
  for (let i = 0; i < RATE_LIMIT_REQUESTS; i++) checkRateLimit("blocked", 0);
  for (let i = 0; i < RATE_LIMIT_MAX_CLIENTS + 50; i++) checkRateLimit("client-" + i, 1);
  // The oldest entry was evicted, so the limiter cannot grow without bound.
  assert.equal(checkRateLimit("blocked", 1), true);
});

test("101st request from one IP returns 429 with Retry-After; other IPs pass", async (t) => {
  const metricsBefore = getMetrics();
  withFetch(t, async () => new Response("ok", { headers: { "Content-Type": "text/plain" } }));
  const send = ip => worker.fetch(new Request("https://hussamfaroug.com/robots.txt", { headers: ip ? { "cf-connecting-ip": ip } : {} }), env);
  for (let i = 0; i < RATE_LIMIT_REQUESTS; i++) assert.equal((await send("203.0.113.9")).status, 200);
  const limited = await send("203.0.113.9");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(limited.headers.get("Cache-Control"), "no-store");
  assert.equal(limited.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await limited.text(), "Rate limit exceeded");
  const head = await worker.fetch(new Request("https://hussamfaroug.com/", { method: "HEAD", headers: { "cf-connecting-ip": "203.0.113.9" } }), env);
  assert.equal(head.status, 429);
  assert.equal((await send("203.0.113.10")).status, 200);
  assert.equal((await send(null)).status, 200);
  // Spoofed forwarding headers do not change the rate-limit key.
  const spoofed = await worker.fetch(new Request("https://hussamfaroug.com/robots.txt", {
    headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }
  }), env);
  assert.equal(spoofed.status, 429);
  assert.equal(getMetrics().requests_rate_limited - metricsBefore.requests_rate_limited, 3);
});

test("origin retry succeeds after one transient failure with 100ms backoff", async (t) => {
  const metricsBefore = getMetrics();
  let calls = 0;
  withFetch(t, async () => {
    if (++calls === 1) throw new TypeError("Failed to fetch");
    return new Response("ok");
  });
  const started = Date.now();
  const response = await fetchOriginWithRetry(env.ORIGIN, new Headers(), new AbortController().signal, 1);
  const elapsed = Date.now() - started;
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 2);
  assert.ok(elapsed >= ORIGIN_RETRY_BASE_DELAY_MS - 5, "waited for backoff");
  assert.ok(elapsed < 1000, "added latency is bounded");
  assert.deepEqual(console.log.mock.calls.map(call => call.arguments[0]), ["origin fetch retry 1/1 after 100ms"]);
  assert.equal(getMetrics().retries_successful - metricsBefore.retries_successful, 1);
});

test("origin retry rethrows the last error after retries are exhausted", async (t) => {
  const metricsBefore = getMetrics();
  let calls = 0;
  withFetch(t, async () => { throw new TypeError("failure " + ++calls); });
  await assert.rejects(fetchOriginWithRetry(env.ORIGIN, new Headers(), new AbortController().signal, 2), /failure 3/);
  assert.equal(calls, 3);
  assert.deepEqual(console.log.mock.calls.map(call => call.arguments[0]), [
    "origin fetch retry 1/2 after 100ms",
    "origin fetch retry 2/2 after 200ms"
  ]);
  assert.equal(getMetrics().errors_retry - metricsBefore.errors_retry, 1);
});

test("origin retry stops when the client cancels", async (t) => {
  let calls = 0;
  const controller = new AbortController();
  withFetch(t, async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  });
  const pending = fetchOriginWithRetry(env.ORIGIN, new Headers(), controller.signal, 3);
  setTimeout(() => controller.abort(), 10);
  const started = Date.now();
  await assert.rejects(pending, /Failed to fetch/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < ORIGIN_RETRY_BASE_DELAY_MS, "backoff wait ends on abort");

  calls = 0;
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(fetchOriginWithRetry(env.ORIGIN, new Headers(), aborted.signal, 3));
  assert.equal(calls, 1);
});

test("Worker retries a transient origin failure and hides exhausted failures", async (t) => {
  let calls = 0;
  withFetch(t, async () => {
    if (++calls === 1) throw new TypeError("Failed to fetch");
    return new Response("hi", { headers: { "Content-Type": "text/plain" } });
  });
  const response = await worker.fetch(new Request("https://hussamfaroug.com/page", { headers: { "cf-connecting-ip": "192.0.2.1" } }), env);
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(await response.text(), "hi");

  calls = 0;
  globalThis.fetch.mock.mockImplementation(async () => {
    calls++;
    throw new TypeError("sensitive origin detail");
  });
  const failed = await worker.fetch(new Request("https://hussamfaroug.com/page?token=secret"), env);
  assert.equal(failed.status, 502);
  assert.equal(calls, 2);
  assert.equal(await failed.text(), "Origin unavailable");
  const logged = [...console.log.mock.calls, ...console.error.mock.calls].flatMap(call => call.arguments).join(" ");
  assert.doesNotMatch(logged, /secret|sensitive/);
});

test("CSP helpers parse, find, read and set directives", () => {
  assert.deepEqual(parseCSPDirectives(null), []);
  assert.deepEqual(parseCSPDirectives(""), []);
  assert.deepEqual(parseCSPDirectives(" ; ;; "), []);
  const directives = parseCSPDirectives(" Default-Src 'self' ;; img-src  data: ");
  assert.deepEqual(directives, ["Default-Src 'self'", "img-src  data:"]);
  assert.equal(getDirectiveIndex(directives, "default-src"), 0);
  assert.equal(getDirectiveIndex(directives, "script-src"), -1);
  assert.deepEqual(getDirectiveSources(directives, "DEFAULT-SRC"), ["'self'"]);
  assert.deepEqual(getDirectiveSources(directives, "script-src"), []);
  setDirectiveSources(directives, "default-src", ["'self'", "'self'", "https://a.example"]);
  setDirectiveSources(directives, "script-src", ["'self'"]);
  setDirectiveSources(directives, "object-src", []);
  assert.deepEqual(directives, ["Default-Src 'self' https://a.example", "img-src  data:", "script-src 'self'", "object-src"]);
});

test("Worker script sources merge without duplicates or loosening the origin policy", () => {
  const worker = ["'nonce-n'", "https://challenges.cloudflare.com"];
  assert.equal(mergeWorkerScriptSources("script-src 'self' https://example.com", worker),
    "script-src 'self' https://example.com 'nonce-n' https://challenges.cloudflare.com");
  assert.equal(mergeWorkerScriptSources("default-src 'self' https://cdn.example; script-src 'self'", worker),
    "default-src 'self' https://cdn.example; script-src 'self' 'nonce-n' https://challenges.cloudflare.com");
  assert.equal(mergeWorkerScriptSources("default-src 'self'; object-src 'none'", worker),
    "default-src 'self'; object-src 'none'; script-src 'self' 'nonce-n' https://challenges.cloudflare.com");
  assert.equal(mergeWorkerScriptSources("script-src 'self'; script-src-elem 'self' https://challenges.cloudflare.com", worker),
    "script-src 'self'; script-src-elem 'self' https://challenges.cloudflare.com 'nonce-n'");
  assert.equal(mergeWorkerScriptSources("img-src *", worker), "img-src *; script-src 'nonce-n' https://challenges.cloudflare.com");
});

test("secHdrs falls back to the Worker CSP when the origin provides none or an empty policy", () => {
  for (const origin of [null, " ; "]) {
    const headers = new Headers(origin === null ? {} : { "Content-Security-Policy": origin });
    secHdrs(headers, "abc");
    const csp = headers.get("Content-Security-Policy");
    assert.match(csp, /^default-src 'self'; script-src 'self' 'nonce-abc' https:\/\/challenges\.cloudflare\.com /);
    assert.match(csp, /object-src 'none'/);
  }
});
