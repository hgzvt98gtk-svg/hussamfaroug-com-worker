import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { authMd, oauthAuthorizationServer, oauthProtectedResource } from "../metadata.js";
import { verifyDeployment } from "../scripts/verify-deployment.mjs";

const site = "https://example.com";
const responses = new Map([
  ["/.well-known/openid-configuration", new Response(JSON.stringify({ issuer: site }))],
  ["/.well-known/oauth-protected-resource", oauthProtectedResource(site)],
  ["/.well-known/oauth-authorization-server", oauthAuthorizationServer(site)],
  ["/.well-known/mcp/server-card.json", new Response(JSON.stringify({ serverInfo: { name: "test" } }))],
  ["/auth.md", authMd(site)],
  ["/", new Response("Worker healthy")]
]);

test("deployment verifier checks Phase 1 endpoints and the healthy Worker path", async () => {
  const requests = [];
  const report = await verifyDeployment("https://example.com/custom/path", {
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, options });
      return responses.get(url.pathname);
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
  assert.equal(report.allEndpoints.length, 9);
  assert.deepEqual(report.allEndpoints.find(item => item.endpoint.includes("discovery chain")), {
    endpoint: "/.well-known/oauth-protected-resource -> /.well-known/oauth-authorization-server -> /auth.md (Auth.md discovery chain)",
    status: "✅"
  });
});

test("deployment verifier fails loudly when production serves stale Auth.md metadata", async () => {
  const stale = {
    "/.well-known/oauth-protected-resource": { resource: site, authorization_servers: [site], resource_documentation: site + "/auth.md" },
    "/.well-known/oauth-authorization-server": { issuer: site, agent_auth: {
      register_uri: site + "/auth.md#agent-registration", identity_types_supported: [], credential_types_supported: []
    } }
  };
  const report = await verifyDeployment(site, {
    fetchImpl: async url => stale[url.pathname]
      ? new Response(JSON.stringify(stale[url.pathname]))
      : url.pathname === "/auth.md"
        ? new Response("# Auth.md\n\nOAuth and MCP documentation")
        : new Response(JSON.stringify({ issuer: site, serverInfo: {} }))
  });
  assert.equal(report.success, false);
  assert.equal(report.results.phase1.oauth, true);
  assert.equal(report.results.phase1.auth, false);
  const chain = report.allEndpoints.find(item => item.endpoint.includes("discovery chain"));
  assert.equal(chain.status, "❌");
  for (const expected of [
    "bearer_methods_supported must include header", "agent_auth.skill must be",
    "identity_types_supported must be a non-empty array", "H1 containing auth.md"
  ]) assert.ok(chain.detail.includes(expected), expected);
});

test("deployment verifier fails OAuth discovery when protected resource metadata is missing", async () => {
  const report = await verifyDeployment("https://example.com", {
    fetchImpl: async url => ({
      "/.well-known/openid-configuration": () => new Response(JSON.stringify({ issuer: "https://example.com" })),
      "/.well-known/oauth-protected-resource": () => new Response("Not Found", { status: 404 }),
      "/.well-known/mcp/server-card.json": () => new Response(JSON.stringify({ serverInfo: { name: "test" } }))
    })[url.pathname]?.() || new Response("OAuth and MCP documentation")
  });

  assert.equal(report.success, false);
  assert.deepEqual(report.results.phase1, { oauth: false, mcp: true, auth: false });
  assert.deepEqual(report.results.phase2, { retry: true, rateLimit: true });
  assert.deepEqual(report.allEndpoints.slice(0, 2), [
    { endpoint: "/.well-known/openid-configuration", status: "✅" },
    { endpoint: "/.well-known/oauth-protected-resource", status: "❌", detail: "HTTP 404" }
  ]);
});

test("deployment verifier reports malformed and missing endpoint responses as failures", async () => {
  const report = await verifyDeployment("https://example.com", {
    fetchImpl: async url => url.pathname === "/"
      ? new Response("Unavailable", { status: 503 })
      : new Response("{}")
  });

  assert.equal(report.success, false);
  assert.equal(report.results.phase1.oauth, false);
  assert.equal(report.results.phase1.mcp, false);
  assert.equal(report.results.phase1.auth, false);
  assert.equal(report.results.phase2.retry, false);
  assert.equal(report.results.phase3.metrics, false);
  assert.ok(report.allEndpoints.some(item => item.detail === "HTTP 503"));
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
