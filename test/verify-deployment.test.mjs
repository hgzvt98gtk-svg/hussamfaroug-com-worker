import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyDeployment } from "../scripts/verify-deployment.mjs";
import { authMd, oauthAuthorizationServer, oauthProtectedResource } from "../metadata.js";

const json = data => new Response(JSON.stringify(data), {
  headers: { "Content-Type": "application/json" }
});

const responses = new Map([
  ["/.well-known/openid-configuration", json({ issuer: "https://example.com" })],
  ["/.well-known/oauth-protected-resource", oauthProtectedResource("https://example.com")],
  ["/.well-known/oauth-authorization-server", oauthAuthorizationServer("https://example.com")],
  ["/.well-known/mcp/server-card.json", json({ serverInfo: { name: "test" } })],
  ["/auth.md", authMd("https://example.com")],
  ["/", new Response("Worker healthy")]
]);

test("deployment verifier checks Phase 1 endpoints and the healthy Worker path", async () => {
  const requests = [];
  const report = await verifyDeployment("https://example.com/custom/path", {
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, options });
      return responses.get(url.pathname).clone();
    }
  });

  assert.equal(report.success, true);
  assert.deepEqual(report.results.phase1, { oauth: true, mcp: true, auth: true });
  assert.deepEqual(report.results.phase2, { retry: true, rateLimit: true });
  assert.equal(report.results.phase3.metrics, true);
  assert.deepEqual(requests.map(item => new URL(item.url).pathname), [
    "/.well-known/openid-configuration", "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/.well-known/mcp/server-card.json", "/auth.md", "/"
  ]);
  assert.ok(requests.every(item => item.options.redirect === "manual"));
  assert.equal(report.allEndpoints.length, 8);
});

test("deployment verifier fails OAuth discovery when protected resource metadata is missing", async () => {
  const report = await verifyDeployment("https://example.com", {
    fetchImpl: async url => url.pathname === "/.well-known/oauth-protected-resource"
      ? new Response("Not Found", { status: 404 })
      : responses.get(url.pathname).clone()
  });

  assert.equal(report.success, false);
  assert.deepEqual(report.results.phase1, { oauth: false, mcp: true, auth: true });
  assert.deepEqual(report.results.phase2, { retry: true, rateLimit: true });
  assert.deepEqual(report.allEndpoints.slice(0, 2), [
    { endpoint: "/.well-known/openid-configuration", status: "✅" },
    { endpoint: "/.well-known/oauth-protected-resource", status: "❌", detail: "HTTP 404" }
  ]);
});

test("deployment verifier rejects missing or invalid agent registration discovery", async () => {
    const metadata = await oauthAuthorizationServer("https://example.com").json();
    for (const response of [
      new Response("Not Found", { status: 404 }),
      json({ issuer: "https://example.com" }),
      json({ ...metadata, agent_auth: { ...metadata.agent_auth, register_uri: "https://other.example/auth.md" } }),
      json({ ...metadata, agent_auth: { ...metadata.agent_auth, skill: undefined } }),
      json({ ...metadata, agent_auth: { ...metadata.agent_auth, identity_types_supported: "anonymous" } }),
      json({ ...metadata, agent_auth: { ...metadata.agent_auth, credential_types_supported: [null] } }),
      new Response(JSON.stringify(metadata), { headers: { "Content-Type": "text/html" } })
    ]) {
      const report = await verifyDeployment("https://example.com", {
        fetchImpl: async url => url.pathname === "/.well-known/oauth-authorization-server"
          ? response : responses.get(url.pathname).clone()
      });
      assert.equal(report.success, false);
      assert.equal(report.results.phase1.oauth, false);
      assert.equal(report.allEndpoints[2].status, "❌");
    }
  });

  test("deployment verifier rejects inconsistent resource links and non-registration Auth.md", async () => {
    for (const [path, response] of [
      ["/.well-known/oauth-protected-resource", json({
        resource: "https://other.example", authorization_servers: ["https://example.com"],
        resource_documentation: "https://example.com/auth.md"
      })],
      ["/.well-known/oauth-protected-resource", json({
        resource: "https://example.com", authorization_servers: ["https://other.example"],
        resource_documentation: "https://example.com/auth.md"
      })],
      ["/auth.md", new Response("OAuth and MCP documentation", { headers: { "Content-Type": "text/markdown" } })],
      ["/auth.md", new Response(await authMd("https://example.com").text(), { headers: { "Content-Type": "text/html" } })]
    ]) {
      const report = await verifyDeployment("https://example.com", {
        fetchImpl: async url => url.pathname === path ? response : responses.get(url.pathname).clone()
      });
      assert.equal(report.success, false);
      assert.equal(report.allEndpoints.find(item => item.endpoint === path).status, "❌");
    }
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
