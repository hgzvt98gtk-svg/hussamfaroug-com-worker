import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { authMd, isLegacyDiscoveryPath, wellKnown } from "../metadata.js";
import { discoveryLinks, SITE_INFO_TOOL } from "../discovery.js";
import { discoveryHtml, linkHdr, webmcp } from "../response.js";

const origin = "https://hussamfaroug.com";
const get = path => wellKnown(new Request(origin + path), () => new Response("{}"));

test("legacy service routes fail locally with an uncacheable 404", async () => {
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/tenant",
    "/.well-known/oauth-protected-resource",
    "/.well-known/openid-configuration",
    "/.well-known/mcp", "/.well-known/mcp.json", "/.well-known/mcp/server-card.json",
    "/.well-known/agent.json", "/a2a", "/a2a/tasks", "/mcp",
    "/oauth/authorize", "/token", "/agent/auth", "/agent/revoke", "/agent/claims"
  ]) {
    assert.equal(isLegacyDiscoveryPath(path), true, path);
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("Cache-Control"), "no-store", path);
  }
  assert.equal(isLegacyDiscoveryPath("/oauthology"), false);
  assert.equal(isLegacyDiscoveryPath("/.well-known/agent-card.json"), false);
  assert.equal(await get("/.well-known/unknown"), null);
});

test("site card describes only public content and a browser tool", async () => {
  const response = await get("/.well-known/agent-card.json");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const card = await response.json();
  assert.equal(card.name, "HussamFaroug Agent");
  assert.equal(card.url, origin);
  assert.deepEqual(card.capabilities, { publicReadOnly: true, browserTools: ["get_site_info"] });
  assert.equal(card.tools[0].execution, "browser-only");
  for (const property of ["supportedInterfaces", "protocolVersion", "preferredTransport", "authentication"]) {
    assert.equal(property in card, false);
  }
});

test("all advertised discovery links resolve locally and are shared across surfaces", async () => {
  const links = discoveryLinks(origin);
  const catalogResponse = await get("/.well-known/api-catalog");
  assert.equal(catalogResponse.headers.get("Content-Type"), "application/linkset+json");
  assert.equal(catalogResponse.headers.get("Cache-Control"), "public, max-age=3600");
  assert.deepEqual((await catalogResponse.json()).linkset, links);
  const aiCatalog = await (await get("/.well-known/ai-catalog.json")).json();
  assert.deepEqual(aiCatalog.entries.map(entry => entry.url), links.map(link => link.href));
  for (const link of links) {
    const path = new URL(link.href).pathname;
    assert.equal(isLegacyDiscoveryPath(path), false);
    assert.match(linkHdr(origin), new RegExp(link.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(discoveryHtml(origin).includes('href="' + link.href + '"'));
    const response = path === "/auth.md" ? authMd(origin) : await get(path);
    assert.equal(response.status, 200, path);
  }
});

test("skills document browser-only execution without credential registration", async () => {
  const skills = await (await get("/.well-known/agent-skills/index.json")).json();
  assert.equal(skills.skills.length, 1);
  assert.equal(skills.skills[0].description, SITE_INFO_TOOL.description);
  const skillResponse = await get(new URL(skills.skills[0].url).pathname);
  assert.equal(skillResponse.headers.get("Content-Type"), "text/markdown");
  assert.match(await skillResponse.text(), /executes in the browser/);
  const auth = await authMd(origin).text();
  assert.match(auth, /public, read-only/);
  assert.match(auth, /No credentials or bearer tokens are required/);
  assert.match(auth, /when signing is configured/);
  assert.doesNotMatch(auth, /POST|client_secret|register_uri|grant_type|authorization_endpoint/);
});

test("WebMCP registration uses the shared tool and executes without network access", async () => {
  const script = webmcp("test-nonce");
  let context;
  vm.runInNewContext(script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>")), {
    navigator: { modelContext: { provideContext: value => { context = value; } } },
    location: { origin }
  });
  assert.equal(context.tools.length, 1);
  assert.equal(context.tools[0].description, SITE_INFO_TOOL.description);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.tools[0].execute())), { name: "hussamfaroug.com", url: origin });
  vm.runInNewContext(script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>")), { navigator: {} });
  assert.ok(webmcp('"><script>').includes('nonce="&quot;&gt;&lt;script&gt;"'));
});

test("health is uncacheable and the signature directory uses the supplied handler", async () => {
  const health = await get("/.well-known/health");
  assert.equal(health.headers.get("Cache-Control"), "no-store");
  assert.equal((await health.json()).status, "ok");
  const request = new Request(origin + "/.well-known/http-message-signatures-directory");
  const result = await wellKnown(request, received => {
    assert.equal(received, request);
    return new Response("configured directory", { status: 503 });
  });
  assert.equal(result.status, 503);
  assert.equal(await result.text(), "configured directory");
});
