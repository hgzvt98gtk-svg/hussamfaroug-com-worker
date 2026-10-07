import { cachedJson, PUBLIC_CACHE_CONTROL } from "./response.js";
import { discoveryLinks, isLegacyDiscoveryPath, SITE_INFO_TOOL } from "./discovery.js";
import { CONTACT } from "./constants.js";

export { isLegacyDiscoveryPath } from "./discovery.js";

function markdownResponse(text) {
  return new Response(text, {
    headers: {
      "Content-Type": "text/markdown",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": PUBLIC_CACHE_CONTROL
    }
  });
}

export function authMd(origin) {
  return markdownResponse([
    "# Auth.md",
    "",
    "This is Hussam Faroug's public, read-only website. No credentials or bearer tokens are required to read its public content and discovery metadata.",
    "",
    "## Disclaimer",
    "",
    "**Important:** This Worker does not implement OAuth authorization, token issuance, an OpenID Connect provider, or automated agent registration.",
    "The OAuth discovery documents describe this public resource and link to manual registration instructions; they do not advertise a functioning authorization or token service. No registration, claim, or revocation API exists.",
    "",
    "## Agent registration",
    "",
    "1. Read " + origin + "/.well-known/oauth-protected-resource and follow authorization_servers to " + origin + "/.well-known/oauth-authorization-server.",
    "2. Follow agent_auth.register_uri (" + origin + "/auth.md#agent-registration) for these manual instructions. This is a documentation URL: read it with GET; do not POST registration requests.",
    "3. To request manual registration, email mailto:" + CONTACT + " with your agent name, operator contact, intended use, and requested access. Wait for an administrator's response; no automated registration or credential issuance is available.",
    "4. Continue reading public content without authentication. Do not send credentials, access tokens, or private keys.",
    "",
    "Supported identity types: none (identity_types_supported is empty). Supported credential types: none (credential_types_supported is empty). Public reading does not register an agent or issue credentials.",
    "Claim and revocation URLs are omitted because no claim or credential revocation service is implemented. Contact the administrator for manual registration changes or cancellation.",
    "",
    "## OAuth discovery metadata",
    "",
    "Protected resource metadata: " + origin + "/.well-known/oauth-protected-resource.",
    "Authorization server metadata: " + origin + "/.well-known/oauth-authorization-server.",
    "OpenID Connect discovery metadata: " + origin + "/.well-known/openid-configuration.",
    "These documents provide discovery and manual-registration metadata only. They do not enable OAuth sign-in, token issuance, or token validation.",
    "",
    "## MCP tool discovery",
    "",
    SITE_INFO_TOOL.description,
    "MCP server card: " + origin + "/.well-known/mcp/server-card.json.",
    "Tool input schemas and capabilities are listed in the card; skill documentation is indexed at " + origin + "/.well-known/agent-skills/.",
    "The tool is registered only in browsers that support navigator.modelContext.provideContext. It is not an HTTP service.",
    "",
    "## HTTP message signature verification",
    "",
    "Public verification keys are available at " + origin + "/.well-known/http-message-signatures-directory when signing is configured.",
    "These keys describe HTTP message signatures, not user identity, OAuth tokens, or credential registration. They cannot verify OAuth tokens. The directory does not grant access or authenticate visitors.",
    "Use the directory's public Ed25519 JWK to verify the Signature over the components listed in Signature-Input, checking the key identifier and created/expires timestamps. Never request or transmit private signing keys.",
    "",
    "Public resource links: " + origin + "/.well-known/api-catalog",
    "",
    "## Contact for manual registration",
    "",
    "Contact: " + CONTACT + " (mailto:" + CONTACT + ").",
    "Provide your agent name, operator contact, intended use, and requested access. Do not email secrets, access tokens, or private keys. Registration is coordinated manually; no automated credential issuance, identity assertion, claim, or revocation endpoint is implemented.",
    ""
  ].join("\n"));
}

export function oauthAuthorizationServer(origin) {
  return cachedJson({
    issuer: origin,
    agent_auth: {
      skill: origin + "/auth.md",
      register_uri: origin + "/auth.md#agent-registration",
      identity_types_supported: [],
      credential_types_supported: []
    }
  });
}

export function oauthProtectedResource(origin) {
  return cachedJson({
    resource: origin,
    authorization_servers: [origin],
    resource_documentation: origin + "/auth.md"
  });
}

export function mcpServerCard(origin) {
  return cachedJson({
    serverInfo: {
      name: "HussamFaroug WebMCP",
      version: "1.0.0",
      description: "Browser-only, read-only tools for Hussam Faroug's public website at " + origin
    },
    capabilities: { tools: [SITE_INFO_TOOL] },
    transport: { type: "browser", endpoint: "navigator.modelContext.provideContext" }
  });
}

function apiCatalog(origin) {
  return cachedJson({ linkset: discoveryLinks(origin) }, { contentType: "application/linkset+json" });
}

function aiCatalog(origin) {
  return cachedJson({
    specVersion: "0.1.0",
    host: { name: "hussamfaroug.com", description: "Hussam Faroug's public, read-only personal website", url: origin },
    entries: discoveryLinks(origin).map(link => ({
      identifier: "urn:site:hussamfaroug.com:" + new URL(link.href).pathname,
      displayName: link.title,
      type: link.type,
      url: link.href,
      description: link.description
    }))
  });
}

function agentSkillsIndex(origin) {
  return cachedJson({
    $schema: "https://agentskills.io/schemas/agent-skills-index.v0.2.json",
    skills: [{
      name: SITE_INFO_TOOL.name,
      type: "tool",
      description: SITE_INFO_TOOL.description,
      url: origin + "/.well-known/agent-skills/get_site_info/SKILL.md",
      execution: "browser-only"
    }],
    links: {
      openidConfiguration: origin + "/.well-known/openid-configuration",
      oauthAuthorizationServer: origin + "/.well-known/oauth-authorization-server",
      oauthProtectedResource: origin + "/.well-known/oauth-protected-resource",
      mcpServerCard: origin + "/.well-known/mcp/server-card.json",
      authMd: origin + "/auth.md"
    }
  });
}

function siteInfoSkill(origin) {
  return markdownResponse([
    "---",
    "name: " + SITE_INFO_TOOL.name,
    "description: " + SITE_INFO_TOOL.description,
    "---",
    "",
    "# get_site_info",
    "",
    "On " + origin + ", a supporting browser registers this read-only tool through navigator.modelContext.provideContext.",
    "Input: an empty object. Output: the site name (hussamfaroug.com) and the current browser location.origin.",
    "This tool executes in the browser. No HTTP MCP endpoint, server transport, credentials, or network request is provided.",
    ""
  ].join("\n"));
}

function agentCard(origin) {
  return cachedJson({
    name: "HussamFaroug Agent",
    version: "1.0.0",
    description: "Public discovery metadata for Hussam Faroug's read-only personal website. This is not an agent-to-agent service.",
    url: origin,
    capabilities: { publicReadOnly: true, browserTools: [SITE_INFO_TOOL.name] },
    tools: [{ ...SITE_INFO_TOOL, execution: "browser-only" }],
    links: {
      apiCatalog: origin + "/.well-known/api-catalog",
      skillsIndex: origin + "/.well-known/agent-skills/index.json",
      authMd: origin + "/auth.md"
    }
  }, { cacheControl: "no-store" });
}

export async function wellKnown(request, botAuth) {
  const url = new URL(request.url);
  if (isLegacyDiscoveryPath(url.pathname)) {
    return new Response("Not Found", { status: 404, headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    } });
  }
  const origin = url.origin;
  const path = url.pathname.replace(/^\/\.well-known\//, "");
  if (path === "http-message-signatures-directory") return botAuth(request);
  if (path === "health") return cachedJson({ status: "ok", timestamp: new Date().toISOString() }, { cacheControl: "no-store" });
  if (path === "api-catalog") return apiCatalog(origin);
  if (path === "ai-catalog.json") return aiCatalog(origin);
  if (path === "openid-configuration" || path === "oauth-authorization-server") return oauthAuthorizationServer(origin);
  if (path === "oauth-protected-resource") return oauthProtectedResource(origin);
  if (path === "mcp/server-card.json") return mcpServerCard(origin);
  if (path === "agent-skills/" || path === "agent-skills/index.json") return agentSkillsIndex(origin);
  if (path === "agent-skills/get_site_info/SKILL.md") return siteInfoSkill(origin);
  if (path === "agent-card.json") return agentCard(origin);
  return null;
}
