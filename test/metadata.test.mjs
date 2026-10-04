import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { authMd, isLegacyDiscoveryPath, wellKnown } from "../metadata.js";
import { discoveryLinks, SITE_INFO_TOOL } from "../discovery.js";
import { discoveryHtml, linkHdr, webmcp } from "../response.js";
import worker from "../hussamfaroug-com-worker.js";
import {
  AUTH_MD_PATH, AUTHORIZATION_SERVER_PATH, PROTECTED_RESOURCE_PATH, validateAuthDiscoveryChain
} from "../scripts/auth-metadata.mjs";

const origin = "https://hussamfaroug.com";
const get = path => wellKnown(new Request(origin + path), () => new Response("{}"));

test("legacy service routes fail locally with an uncacheable 404", async () => {
  for (const path of [
    "/.well-known/oauth-authorization-server/tenant",
    "/.well-known/oauth-protected-resource/tenant",
    "/.well-known/openid-configuration/tenant",
    "/.well-known/mcp", "/.well-known/mcp.json", "/.well-known/mcp/server-card.json/extra",
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

test("OAuth and MCP discovery endpoints return public JSON through Worker GET and HEAD routes", async () => {
  for (const host of [origin, "https://preview.example.com:8443"]) {
    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/mcp/server-card.json"
    ]) {
      assert.equal(isLegacyDiscoveryPath(path), false);
      for (const method of ["GET", "HEAD"]) {
        const response = await worker.fetch(new Request(host + path + "?ignored=value", {
          method, headers: { Authorization: "test-only", Cookie: "test-only" }
        }), {});
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get("Content-Type"), "application/json", path);
        assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600", path);
        assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*", path);
        if (method === "HEAD") {
          assert.equal(await response.text(), "");
          continue;
        }
        const data = await response.json();
        if (path.endsWith("oauth-protected-resource")) {
          assert.deepEqual(data, {
            resource: host,
            authorization_servers: [host],
            scopes_supported: ["openid", "profile"],
            bearer_methods_supported: ["header"],
            resource_documentation: host + "/auth.md"
          });
        } else if (path.endsWith("server-card.json")) {
          assert.equal(data.serverInfo.name, "HussamFaroug WebMCP");
          assert.equal(data.serverInfo.version, "1.0.0");
          assert.ok(data.serverInfo.description.includes(host));
          assert.deepEqual(data.capabilities, { tools: [SITE_INFO_TOOL] });
          assert.deepEqual(data.transport, { type: "browser", endpoint: "navigator.modelContext.provideContext" });
        } else {
          assert.deepEqual(data, {
            issuer: host,
            authorization_endpoint: host + "/.well-known/authorize",
            token_endpoint: host + "/.well-known/token",
            jwks_uri: host + "/.well-known/jwks",
            grant_types_supported: ["implicit", "authorization_code"],
            scopes_supported: ["openid", "profile"],
            response_types_supported: ["code", "token"],
            token_endpoint_auth_methods_supported: ["none"],
            agent_auth: {
              skill: host + "/auth.md",
              register_uri: host + "/auth.md#agent-registration",
              identity_types_supported: ["anonymous"],
              credential_types_supported: ["none"],
              anonymous: { credential_types_supported: ["none"] }
            }
          });
        }
      }
    }
  }
});

test("OAuth protected resource metadata is delivered directly by the Worker", async () => {
  const response = await worker.fetch(new Request(origin + "/.well-known/oauth-protected-resource", {
    headers: { Accept: "application/json", "cf-connecting-ip": "192.0.2.10" }
  }), {});
  assert.equal(response.status, 200);
  assert.equal(response.redirected, false);
  assert.equal(response.headers.get("Location"), null);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  assert.deepEqual(await response.json(), {
    resource: origin,
    authorization_servers: [origin],
    scopes_supported: ["openid", "profile"],
    bearer_methods_supported: ["header"],
    resource_documentation: origin + "/auth.md"
  });
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

test("skills index links authentication and MCP metadata while retaining browser-only execution", async () => {
  const skills = await (await get("/.well-known/agent-skills/index.json")).json();
  const indexResponse = await get("/.well-known/agent-skills/");
  assert.equal(indexResponse.headers.get("Content-Type"), "application/json");
  assert.equal(indexResponse.headers.get("Cache-Control"), "public, max-age=3600");
  assert.equal(indexResponse.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(await indexResponse.json(), skills);
  assert.deepEqual(skills.links, {
    openidConfiguration: origin + "/.well-known/openid-configuration",
    oauthAuthorizationServer: origin + "/.well-known/oauth-authorization-server",
    oauthProtectedResource: origin + "/.well-known/oauth-protected-resource",
    mcpServerCard: origin + "/.well-known/mcp/server-card.json",
    authMd: origin + "/auth.md"
  });
  for (const url of Object.values(skills.links)) {
    const response = await worker.fetch(new Request(url), {});
    assert.equal(response.status, 200);
  }
  assert.equal(skills.skills.length, 1);
  assert.equal(skills.skills[0].description, SITE_INFO_TOOL.description);
  const skillResponse = await get(new URL(skills.skills[0].url).pathname);
  assert.equal(skillResponse.headers.get("Content-Type"), "text/markdown");
  assert.match(await skillResponse.text(), /executes in the browser/);
});

test("auth.md documents discovery, manual registration, and separate signature verification", async () => {
  const response = await worker.fetch(new Request(origin + "/auth.md"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/markdown");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const auth = await response.text();
  assert.match(auth, /^# hussamfaroug\.com auth\.md\n/);
  assert.match(auth, /You are an agent\./);
  assert.match(auth, /\*\*agentic registration\*\*/);
  assert.ok(auth.indexOf("## Disclaimer") < auth.indexOf("## OpenID Connect"));
  assert.match(auth, /\*\*Important:\*\* This Worker does not implement OAuth token issuance, an OpenID Connect provider, or automated agent registration/);
  assert.match(auth, /endpoints do not function; do not attempt to authenticate/);
  assert.match(auth, /registration is manual only/i);
  for (const heading of [
    "Disclaimer",
    "OpenID Connect / OAuth 2.0 registration",
    "Agent registration",
    "MCP tool discovery",
    "HTTP message signature verification",
    "Contact for credential registration"
  ]) assert.ok(auth.includes("## " + heading));
  assert.match(auth, /public, read-only/);
  assert.match(auth, /No credentials or bearer tokens are required/);
  assert.match(auth, /when signing is configured/);
  assert.match(auth, /Phase 1 publishes discovery metadata only/);
  assert.match(auth, /does not implement an OAuth authorization server/);
  assert.match(auth, /no automated credential issuance/);
  assert.match(auth, /admin@hussamfaroug\.com/);
  assert.match(auth, /not OAuth token verification keys/);
  assert.match(auth, /identity_types_supported is \["anonymous"\]/);
  assert.match(auth, /credential_types_supported are \["none"\]/);
  assert.match(auth, /No credential, token, or identity assertion is issued/);
  assert.match(auth, /does not require or validate bearer tokens/);
  assert.match(auth, /Claim and revocation URLs are omitted/);
  assert.match(auth, /do not POST registration requests/);
  for (const path of [
    "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource", "/.well-known/mcp/server-card.json",
    "/.well-known/agent-skills/", "/.well-known/http-message-signatures-directory"
  ]) assert.ok(auth.includes(origin + path));
});

test("agent registration metadata links root instructions without advertising unavailable APIs", async () => {
  const response = await worker.fetch(new Request(origin + "/.well-known/oauth-authorization-server"), {});
  const { agent_auth } = await response.json();
  assert.deepEqual(Object.keys(agent_auth).sort(), [
    "anonymous", "credential_types_supported", "identity_types_supported", "register_uri", "skill"
  ]);
  assert.deepEqual(agent_auth.anonymous, { credential_types_supported: ["none"] });
  assert.equal(agent_auth.skill, origin + "/auth.md");
  const registrationUrl = new URL(agent_auth.register_uri);
  assert.equal(registrationUrl.origin, origin);
  assert.equal(registrationUrl.pathname, "/auth.md");
  assert.equal(registrationUrl.hash, "#agent-registration");
  for (const method of ["GET", "HEAD"]) {
    const instructions = await worker.fetch(new Request(registrationUrl, { method }), {});
    assert.equal(instructions.status, 200);
    assert.equal(instructions.redirected, false);
    assert.equal(instructions.headers.get("Content-Type"), "text/markdown");
    assert.equal(instructions.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(instructions.headers.get("Cache-Control"), "public, max-age=3600");
    const text = await instructions.text();
    if (method === "HEAD") assert.equal(text, "");
    else {
      assert.match(text, /## Agent registration/);
      assert.match(text, /mailto:admin@hussamfaroug\.com/);
    }
  }
  const post = await worker.fetch(new Request(registrationUrl, { method: "POST" }), {});
  assert.equal(post.status, 405);
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

async function fetchChain(host) {
  const prmResponse = await worker.fetch(new Request(host + PROTECTED_RESOURCE_PATH), {});
  const protectedResource = await prmResponse.json();
  const asUrl = new URL(AUTHORIZATION_SERVER_PATH, protectedResource.authorization_servers[0]);
  const authorizationServer = await (await worker.fetch(new Request(asUrl), {})).json();
  const docUrl = new URL(authorizationServer.agent_auth.skill);
  assert.equal(docUrl.href, protectedResource.resource_documentation);
  const authMdText = await (await worker.fetch(new Request(docUrl), {})).text();
  return { origin: host, protectedResource, authorizationServer, authMd: authMdText };
}

test("Auth.md discovery chain resolves from PRM through AS metadata to /auth.md on every host", async () => {
  for (const host of [origin, "https://preview.example.com:8443"]) {
    assert.deepEqual(validateAuthDiscoveryChain(await fetchChain(host)), [], host);
  }
});

test("Auth.md discovery chain validator rejects malformed, inconsistent, or untruthful metadata", async () => {
  const valid = await fetchChain(origin);
  const clone = () => structuredClone(valid);
  const cases = [
    ["missing PRM", chain => { chain.protectedResource = "Not Found"; }, /protected resource metadata is not a JSON object/],
    ["cross-origin resource", chain => { chain.protectedResource.resource = "https://www.hussamfaroug.com"; }, /resource must be/],
    ["foreign authorization server", chain => { chain.protectedResource.authorization_servers = ["https://auth.example.com"]; }, /issuer does not match authorization_servers\[0\]/],
    ["empty authorization servers", chain => { chain.protectedResource.authorization_servers = []; }, /authorization_servers must be a non-empty array/],
    ["missing bearer methods", chain => { delete chain.protectedResource.bearer_methods_supported; }, /bearer_methods_supported must include header/],
    ["wrong documentation", chain => { chain.protectedResource.resource_documentation = origin + "/docs"; }, /resource_documentation must be/],
    ["wrong issuer", chain => { chain.authorizationServer.issuer = origin + "/"; }, /issuer must be/],
    ["missing agent_auth", chain => { delete chain.authorizationServer.agent_auth; }, /agent_auth block is missing/],
    ["missing skill", chain => { delete chain.authorizationServer.agent_auth.skill; }, /agent_auth\.skill must be/],
    ["registration API", chain => { chain.authorizationServer.agent_auth.register_uri = origin + "/agent/register"; }, /agent_auth\.register_uri must be/],
    ["empty identity types", chain => { chain.authorizationServer.agent_auth.identity_types_supported = []; }, /identity_types_supported must be a non-empty array/],
    ["empty credential types", chain => { chain.authorizationServer.agent_auth.credential_types_supported = []; }, /credential_types_supported must be a non-empty array/],
    ["incomplete anonymous method", chain => { delete chain.authorizationServer.agent_auth.anonymous; }, /anonymous\.credential_types_supported must be a non-empty array/],
    ["claim URL", chain => { chain.authorizationServer.agent_auth.claim_uri = origin + "/agent/claim"; }, /agent_auth\.claim_uri advertises an unimplemented service/],
    ["nested claim URL", chain => { chain.authorizationServer.agent_auth.anonymous.claim_uri = origin + "/agent/claim"; }, /agent_auth\.anonymous\.claim_uri is not a supported field/],
    ["revocation URL", chain => { chain.authorizationServer.agent_auth.revocation_uri = origin + "/agent/revoke"; }, /agent_auth\.revocation_uri advertises an unimplemented service/],
    ["revocation endpoint", chain => { chain.authorizationServer.revocation_endpoint = origin + "/oauth/revoke"; }, /revocation_endpoint advertises an unimplemented service/],
    ["misspelled field", chain => { chain.authorizationServer.agent_auth.registration_uri = origin + "/auth.md"; }, /agent_auth\.registration_uri is not a supported field/],
    ["stale auth.md heading", chain => { chain.authMd = chain.authMd.replace(/^# [^\n]*/, "# Auth"); }, /H1 containing auth\.md/],
    ["missing registration markers", chain => { chain.authMd = chain.authMd.replace("You are an agent", "Agents"); }, /missing marker You are an agent/],
    ["missing registration anchor", chain => { chain.authMd = chain.authMd.replace("## Agent registration", "## Registration"); }, /no #agent-registration heading/],
    ["missing PRM link", chain => { chain.authMd = chain.authMd.replaceAll(origin + PROTECTED_RESOURCE_PATH, ""); }, /does not link .*oauth-protected-resource/],
    ["HTML instead of Markdown", chain => { chain.authMd = "<!doctype html><title>Home</title>"; }, new RegExp(AUTH_MD_PATH.replace(".", "\\.") + ": auth\\.md must start")]
  ];
  for (const [name, mutate, expected] of cases) {
    const chain = clone();
    mutate(chain);
    const issues = validateAuthDiscoveryChain(chain);
    assert.ok(issues.some(issue => expected.test(issue)), name + ": " + JSON.stringify(issues));
  }
  assert.deepEqual(validateAuthDiscoveryChain({ ...clone(), origin: "not a url" }), ["origin is not a valid URL"]);
});
