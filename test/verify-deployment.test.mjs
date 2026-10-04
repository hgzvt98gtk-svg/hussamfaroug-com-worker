import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyDeployment } from "../scripts/verify-deployment.mjs";
import { authMd, oauthAuthorizationServer, oauthProtectedResource } from "../metadata.js";

const origin = "https://example.com";
const json = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const responses = new Map([
  ["/.well-known/openid-configuration", () => json({ issuer: origin })],
  ["/.well-known/oauth-protected-resource", () => oauthProtectedResource(origin)],
  ["/.well-known/oauth-authorization-server", () => oauthAuthorizationServer(origin)],
  ["/.well-known/mcp/server-card.json", () => json({ serverInfo: { name: "test" } })],
  ["/auth.md", () => authMd(origin)],
  ["/", () => new Response("Worker healthy")]
]);

test("deployment verifier checks Phase 1 endpoints and the healthy Worker path", async () => {
  const requests = [];
  const report = await verifyDeployment(origin + "/custom/path", {
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, options });
      return responses.get(url.pathname)?.();
    }
  });

  assert.equal(report.success, true);
  assert.deepEqual(report.results.phase1, { oauth: true, mcp: true, auth: true });
  assert.deepEqual(report.results.phase2, { retry: true, rateLimit: true });
  assert.equal(report.results.phase3.metrics, true);
  assert.deepEqual(requests.map(item => new URL(item.url).pathname), [
    "/.well-known/openid-configuration", "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server", "/.well-known/mcp/server-card.json", "/auth.md", "/"
  ]);
  assert.ok(requests.every(item => item.options.redirect === "manual"));
  assert.equal(report.allEndpoints.length, 8);
});

test("deployment verifier fails OAuth discovery when protected resource metadata is missing", async () => {
  const report = await verifyDeployment("https://example.com", {
    fetchImpl: async url => ({
      "/.well-known/openid-configuration": () => json({ issuer: origin }),
      "/.well-known/oauth-protected-resource": () => new Response("Not Found", { status: 404 }),
      "/.well-known/oauth-authorization-server": () => oauthAuthorizationServer(origin),
      "/.well-known/mcp/server-card.json": () => json({ serverInfo: { name: "test" } })
    })[url.pathname]?.() || authMd(origin)
  });

  assert.equal(report.success, false);
  assert.deepEqual(report.results.phase1, { oauth: false, mcp: true, auth: false });
  assert.deepEqual(report.results.phase2, { retry: true, rateLimit: true });
  assert.deepEqual(report.allEndpoints.slice(0, 2), [
    { endpoint: "/.well-known/openid-configuration", status: "✅" },
    { endpoint: "/.well-known/oauth-protected-resource", status: "❌", detail: "HTTP 404" }
  ]);
});

test("deployment verifier rejects inconsistent and malformed Auth.md discovery metadata", async () => {
  for (const [path, mutate] of [
    ["/.well-known/oauth-protected-resource", data => { data.resource = "https://other.example"; }],
    ["/.well-known/oauth-protected-resource", data => { data.authorization_servers = []; }],
    ["/.well-known/oauth-protected-resource", data => { data.resource_documentation = origin + "/docs/auth.md"; }],
    ["/.well-known/oauth-authorization-server", data => { data.agent_auth.register_uri = origin + "/register"; }],
    ["/.well-known/oauth-authorization-server", data => {
      data.agent_auth.identity_types_supported = ["anonymous"];
      data.revocation_endpoint = origin + "/oauth/revoke";
    }]
  ]) {
    const report = await verifyDeployment(origin, {
      fetchImpl: async url => {
        if (url.pathname === path) {
          const data = await responses.get(path)().json();
          mutate(data);
          return json(data);
        }
        return responses.get(url.pathname)?.() || new Response("Worker healthy");
      }
    });
    assert.equal(report.success, false);
    assert.equal(report.results.phase1.oauth, false);
    assert.equal(report.allEndpoints.find(item =>
      item.endpoint === path).status, "❌");
  }

  const missingAgentAuth = await verifyDeployment(origin, {
    fetchImpl: async url => url.pathname === "/.well-known/oauth-authorization-server"
      ? json({ issuer: origin })
      : responses.get(url.pathname)?.() || new Response("Worker healthy")
  });
  assert.equal(missingAgentAuth.success, false);
  assert.equal(missingAgentAuth.results.phase1.oauth, false);
  assert.equal(missingAgentAuth.allEndpoints.find(item =>
    item.endpoint === "/.well-known/oauth-authorization-server").status, "❌");
});

test("deployment verifier reports malformed and missing endpoint responses as failures", async () => {
  const report = await verifyDeployment("https://example.com", {
    fetchImpl: async url => url.pathname === "/"
      ? new Response("Unavailable", { status: 503 })
      : json({})
  });

  assert.equal(report.success, false);
  assert.equal(report.results.phase1.oauth, false);
  assert.equal(report.results.phase1.mcp, false);
  assert.equal(report.results.phase1.auth, false);
  assert.equal(report.results.phase2.retry, false);
  assert.equal(report.results.phase3.metrics, false);
  assert.ok(report.allEndpoints.some(item => item.detail === "HTTP 503"));
});

test("deployment verifier rejects missing, malformed and redirected discovery responses", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/auth.md"
  ]) {
    for (const response of [
      () => new Response("Not Found", { status: 404 }),
      () => new Response("{", { headers: { "content-type": "application/json" } }),
      () => new Response("<html>Not metadata</html>", { headers: { "content-type": "text/html" } }),
      () => new Response(null, { status: 302, headers: { location: origin + "/docs/auth.md" } })
    ]) {
      const report = await verifyDeployment(origin, {
        fetchImpl: async url => url.pathname === path ? response() : responses.get(url.pathname)()
      });
      assert.equal(report.success, false, path);
      assert.equal(report.allEndpoints.find(item => item.endpoint === path).status, "❌", path);
    }
  }
});

test("deployment verifier handles request failures and rejects unsafe origins", async () => {
  const failed = await verifyDeployment("https://example.com", {
    fetchImpl: async () => { throw new TypeError("network failure"); }
  });
  assert.equal(failed.success, false);
  assert.ok(failed.allEndpoints.every(item => item.status === "❌"));

  const invalid = await verifyDeployment("******example.com", {
    fetchImpl: async () => { throw new Error("must not be called"); }
  });
  assert.equal(invalid.success, false);
  assert.equal(invalid.error, "Invalid origin");
});

test("verification script works as a CLI and exits nonzero for invalid origins", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-deployment.mjs", "not-a-url"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"error": "Invalid origin"/);
});
