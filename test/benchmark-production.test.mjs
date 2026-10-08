import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { compareBenchmarks, formatBenchmarkMarkdown } from "../scripts/benchmark-utils.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/benchmark-production.mjs", import.meta.url));

async function benchmark(pages, { sitemap = true, status = 200, githubActions = false, markdownResponses = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-production-"));
  const output = join(directory, "current.json");
  try {
    const { stderr } = await exec(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      const [pages, script, output, sitemap, status, markdownResponses] = JSON.parse(process.argv[1]);
      globalThis.fetch = async (url, options) => {
        assert.equal(options.method, "GET");
        assert.equal(options.redirect, "manual");
        assert.ok(options.headers["user-agent"].startsWith("hussamfaroug-com-worker-benchmark/"));
        const path = new URL(url).pathname;
        if (options.headers.accept === "text/markdown") {
          assert.ok(pages.some(page => page.path === path));
          const scripted = markdownResponses.shift();
          if (scripted === "network") throw new TypeError("fetch failed");
          if (scripted) return new Response(scripted.body, { status: scripted.status, headers: scripted.headers });
          return new Response("# Page", {
            status, headers: { "content-type": "text/markdown" }
          });
        }
        if (path === "/sitemap.xml" && sitemap) {
          return new Response("<urlset>" + pages.map(page =>
            "<url><loc>" + new URL(page.path, url) + "</loc></url>"
          ).join("") + "</urlset>", { headers: { "content-type": "application/xml" } });
        }
        const page = pages.find(page => page.path === path);
        if (!page) return new Response("Not found", { status: 404 });
        const html = "<html>" + pages.map(page =>
          '<a href="' + page.path + '">Page</a>'
        ).join("") + "</html>";
        return new Response(html.padEnd(page.bytes, " "), {
          headers: { "content-type": "text/html" }
        });
      };
      process.argv = [process.execPath, script, "--iterations", "1", "--warmups", "1",
        "--output", output];
      await import(pathToFileURL(script));
    `, JSON.stringify([pages, script, output, sitemap, status, markdownResponses])], {
      env: { ...process.env, GITHUB_ACTIONS: String(githubActions), BENCHMARK_RETRY_BASE_MS: "1" }
    });
    return { result: JSON.parse(await readFile(output, "utf8")), stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("single-page origin completes the CLI and reports incomplete coverage", async () => {
  const { result, stderr } = await benchmark([{ path: "/", bytes: 12_000 }], { sitemap: false });
  assert.equal(result.success, true);
  assert.deepEqual(result.sampling, {
    mode: "reduced-sample", requestedPages: 3, measuredPages: 1
  });
  assert.equal(result.fixtures.length, 1);
  const fixture = result.fixtures[0];
  assert.equal(fixture.name, "10kb");
  assert.equal(fixture.path, "/");
  assert.equal(fixture.sourceHtmlBytes, 12_000);
  assert.equal(fixture.samples.length, 2);
  assert.match(stderr, /incomplete target-size coverage/);
  assert.match(stderr, /^Reduced-sample mode:/);
  assert.doesNotMatch(stderr, /::warning::/);
  assert.match(result.methodology, /Up to three distinct/);
  const comparison = compareBenchmarks(result);
  assert.equal(comparison.passed, true);
  assert.equal(comparison.baselineEstablished, true);
  assert.match(formatBenchmarkMarkdown(result, comparison), /Coverage: 1 of 3 target slots measured/);
});

test("single large page is assigned to its closest target, not always 10kb", async () => {
  const { result } = await benchmark([{ path: "/", bytes: 450_000 }]);
  assert.equal(result.fixtures[0].name, "500kb");
});

test("two-page origin measures distinct pages and emits an Actions warning", async () => {
  const { result, stderr } = await benchmark([
    { path: "/", bytes: 100_000 }, { path: "/large", bytes: 500_000 }
  ], { sitemap: false, githubActions: true });
  assert.deepEqual(result.fixtures.map(page => [page.name, page.path]), [
    ["100kb", "/"], ["500kb", "/large"]
  ]);
  assert.equal(result.success, true);
  assert.deepEqual(result.sampling, {
    mode: "reduced-sample", requestedPages: 3, measuredPages: 2
  });
  assert.match(stderr, /^::warning::Reduced-sample mode: found only 2 eligible HTML page\(s\)/);
});

test("three-target selection is preserved when more pages are available", async () => {
  const { result, stderr } = await benchmark([
    { path: "/", bytes: 10_000 }, { path: "/extra", bytes: 25_000 },
    { path: "/medium", bytes: 100_000 }, { path: "/large", bytes: 500_000 }
  ], { githubActions: true });
  assert.deepEqual(result.fixtures.map(page => [page.name, page.path]), [
    ["10kb", "/"], ["100kb", "/medium"], ["500kb", "/large"]
  ]);
  assert.equal(stderr, "");
  assert.deepEqual(result.sampling, {
    mode: "full-sample", requestedPages: 3, measuredPages: 3
  });
});

test("discovery still fails when no eligible HTML pages exist", async () => {
  await assert.rejects(benchmark([]), /Found no eligible HTML pages/);
});

test("request failures still fail comparison for a single-page origin", async () => {
  const { result } = await benchmark([{ path: "/", bytes: 10_000 }], { status: 503 });
  assert.equal(result.success, false);
  assert.equal(result.fixtures[0].errors, 2);
  assert.equal(compareBenchmarks(result).passed, false);
});

test("transient failures are retried and the final attempt is measured", async () => {
  const { result } = await benchmark([{ path: "/", bytes: 10_000 }], {
    markdownResponses: ["network", { status: 503, body: "busy", headers: { "retry-after": "0" } }]
  });
  assert.equal(result.success, true);
  const [warmup, measured] = result.fixtures[0].samples;
  assert.equal(warmup.attempts, 3);
  assert.equal(warmup.status, 200);
  assert.equal(measured.attempts, 1);
  assert.equal(result.fixtures[0].retries, 2);
  assert.match(formatBenchmarkMarkdown(result, compareBenchmarks(result)), /Retries: 2 transient failure/);
});

test("403 responses are not retried and report which layer responded", async () => {
  const edgeBlock = {
    status: 403,
    body: "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>",
    headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "abc123-IAD" }
  };
  const workerProxied = {
    status: 403,
    body: "# Forbidden",
    headers: { "content-type": "text/markdown", vary: "Accept", server: "cloudflare" }
  };
  const { result } = await benchmark([{ path: "/", bytes: 10_000 }], { markdownResponses: [edgeBlock, workerProxied] });
  assert.equal(result.success, false);
  const [edge, worker] = result.fixtures[0].samples;
  assert.equal(edge.attempts, 1);
  assert.deepEqual(edge.diagnostics, {
    respondedBy: "cloudflare-edge", server: "cloudflare", cfMitigated: null, title: "Attention Required! | Cloudflare"
  });
  assert.equal(worker.diagnostics.respondedBy, "worker");
  const { regressions } = compareBenchmarks(result);
  assert.ok(regressions.includes(
    '10kb: HTTP 403 on iteration 1 (responded by cloudflare-edge; title "Attention Required!   Cloudflare"; cf-ray abc123-IAD)'
  ));
  assert.ok(regressions.includes("10kb: HTTP 403 on iteration 1 (responded by worker)"));
});
