import { cachedJson, PUBLIC_CACHE_CONTROL } from "./response.js";

const CONTACT = "admin@hussamfaroug.com";

export function agentAuthMetadata(origin) {
  return {
    register_uri: origin + "/agent/auth",
    identity_types_supported: ["identity_assertion", "anonymous"],
    credential_types_supported: ["client_secret", "private_key_jwt", "signed_http_request"],
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/token",
    revocation_uri: origin + "/agent/revoke",
    claim_uri: origin + "/agent/claims",
    documentation_uri: origin + "/auth.md"
  };
}

export function authMd(origin) {
  var fence = String.fromCharCode(96, 96, 96);
  return new Response([
    "# auth.md",
    "",
    "You are an agent. This document tells you how to register a credential for hussamfaroug.com.",
    "",
    "## Agent Authentication",
    "",
    fence + "json",
    JSON.stringify({ agent_auth: agentAuthMetadata(origin) }, null, 2),
    fence,
    "",
    "",
    "## Step 1 - Register",
    "",
    "POST to the registration endpoint with your desired client metadata:",
    "",
    fence + "http",
    "POST /agent/auth HTTP/1.1",
    "Host: hussamfaroug.com",
    "Content-Type: application/json",
    "",
    JSON.stringify({
      client_name: "My AI Agent",
      redirect_uris: ["https://my-agent.example.com/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    }),
    fence,
    "",
    "",
    "## Step 2 - Authorize",
    "",
    "Open the authorization endpoint in a browser:",
    "",
    fence,
    origin + "/oauth/authorize?response_type=code&client_id=agent-1234567890&redirect_uri=https://my-agent.example.com/callback&scope=agent:register&code_challenge=<PKCE_CHALLENGE>&code_challenge_method=S256",
    fence,
    "",
    "",
    "## Step 3 - Exchange code for token",
    "",
    fence + "http",
    "POST /token HTTP/1.1",
    "Host: hussamfaroug.com",
    "Content-Type: application/x-www-form-urlencoded",
    "",
    "grant_type=authorization_code&code=<code>&redirect_uri=https://my-agent.example.com/callback&code_verifier=<PKCE_VERIFIER>",
    fence,
    "",
    "",
    "## Step 4 - Use the token",
    "",
    fence + "http",
    "GET / HTTP/1.1",
    "Host: hussamfaroug.com",
    "Authorization: ******",
    fence,
    "",
    "",
    "## Endpoints",
    "",
    "- register_uri: " + origin + "/agent/auth",
    "- authorization_endpoint: " + origin + "/oauth/authorize",
    "- token_endpoint: " + origin + "/token",
    "- revocation_uri: " + origin + "/agent/revoke",
    "- claim_uri: " + origin + "/agent/claims",
    "- jwks_uri: " + origin + "/.well-known/http-message-signatures-directory",
    "",
    "Contact: " + CONTACT,
    ""
  ].join("\n"), {
    headers: {
      "Content-Type": "text/markdown",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": PUBLIC_CACHE_CONTROL
    }
  });
}

function oauthAs(origin) {
  return cachedJson({
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/token",
    registration_endpoint: origin + "/agent/auth",
    revocation_endpoint: origin + "/agent/revoke",
    jwks_uri: origin + "/.well-known/http-message-signatures-directory",
    scopes_supported: ["read", "write", "agent:register"],
    response_types_supported: ["code", "token"],
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    agent_auth: agentAuthMetadata(origin),
    documentation: origin + "/auth.md"
  });
}

function oauthPr(origin) {
  return cachedJson({
    resource: origin,
    authorization_servers: [origin],
    scopes_supported: ["read", "write", "agent:register"],
    bearer_methods_supported: ["header"],
    resource_documentation: origin + "/auth.md",
    jwks_uri: origin + "/.well-known/http-message-signatures-directory",
    agent_auth: agentAuthMetadata(origin)
  });
}

function openid(origin) {
  return cachedJson({
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/token",
    userinfo_endpoint: origin + "/agent/claims",
    jwks_uri: origin + "/.well-known/http-message-signatures-directory",
    response_types_supported: ["code", "token", "id_token"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["read", "write", "agent:register"],
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    claims_supported: ["sub", "email", "email_verified", "name", "groups"]
  });
}

function mcpMetadata(origin) {
  return {
    serverInfo: { name: "hussamfaroug.com", version: "1.0.0" },
    transport: { type: "http", url: origin + "/.well-known/mcp" },
    capabilities: { tools: true, resources: true, prompts: false },
    tools: [{ name: "get_site_info", description: "Get information about hussamfaroug.com", inputSchema: { type: "object", properties: {} } }]
  };
}

function ard(origin) {
  return cachedJson({
    linkset: [
      { anchor: origin, href: origin + "/.well-known/mcp/server-card.json", rel: "service-meta", type: "application/vnd.mcp.server+json", title: "HussamFaroug MCP Server", description: "MCP server for hussamfaroug.com" },
      { anchor: origin, href: origin + "/.well-known/agent-card.json", rel: "agent", type: "application/vnd.a2a.agent+json", title: "HussamFaroug A2A Agent", description: "A2A-compatible AI agent for hussamfaroug.com" },
      { anchor: origin, href: origin + "/.well-known/oauth-authorization-server", rel: "service-desc", type: "application/json", title: "OAuth Authorization Server", description: "OAuth authorization server metadata" },
      { anchor: origin, href: origin + "/auth.md", rel: "service-doc", type: "text/markdown", title: "Agent Auth Documentation", description: "How to register a credential for hussamfaroug.com" },
      { anchor: origin, href: origin + "/.well-known/health", rel: "status", type: "application/json", title: "Health Check", description: "Service health endpoint" }
    ]
  }, { contentType: "application/linkset+json" });
}

function aiCatalog(origin) {
  return cachedJson({
    specVersion: "0.1.0",
    host: { name: "hussamfaroug.com", description: "Personal website for Hussam Faroug - AI agent-ready", url: origin },
    entries: [
      { identifier: "urn:air:hussamfaroug.com:mcp:server", displayName: "HussamFaroug MCP Server", type: "application/vnd.mcp.server+json", url: origin + "/.well-known/mcp/server-card.json", description: "MCP server for hussamfaroug.com", representativeQueries: ["what tools does the hussamfaroug MCP server expose", "how do I connect to the hussamfaroug MCP server", "what is the MCP server card for hussamfaroug.com"] },
      { identifier: "urn:air:hussamfaroug.com:a2a:agent", displayName: "HussamFaroug A2A Agent", type: "application/vnd.a2a.agent+json", url: origin + "/.well-known/agent-card.json", description: "A2A-compatible AI agent for hussamfaroug.com", representativeQueries: ["what is the agent card for hussamfaroug.com", "how do I interact with the hussamfaroug agent"] },
      { identifier: "urn:air:hussamfaroug.com:auth", displayName: "HussamFaroug Auth", type: "application/json", url: origin + "/.well-known/oauth-authorization-server", description: "OAuth authorization server metadata for hussamfaroug.com", representativeQueries: ["how do I authenticate with hussamfaroug.com", "what OAuth endpoints does hussamfaroug.com support"] }
    ]
  });
}

function agentSkillsIndex(origin) {
  return cachedJson({
    $schema: "https://agentskills.io/schemas/agent-skills-index.v0.2.json",
    skills: [
      { name: "get_site_info", type: "tool", description: "Get information about hussamfaroug.com", url: origin + "/.well-known/agent-skills/get_site_info/SKILL.md" },
      { name: "agent_auth", type: "skill", description: "Register a credential for hussamfaroug.com", url: origin + "/auth.md" }
    ]
  });
}

function healthCheck() {
  return cachedJson({ status: "ok", timestamp: new Date().toISOString() }, { cacheControl: "no-store" });
}

function agentCard(origin) {
  return cachedJson({
    schemaVersion: "1.0",
    name: "HussamFaroug Agent",
    version: "1.0.0",
    description: "AI agent for hussamfaroug.com providing API access, content retrieval, and agent-to-agent communication.",
    url: origin + "/a2a",
    protocolVersion: "1.0",
    preferredTransport: "jsonrpc",
    supportedInterfaces: [{
      protocol: "jsonrpc",
      version: "2.0",
      url: origin + "/a2a",
      transport: "http",
      streaming: true,
      pushNotifications: true
    }],
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
    skills: [
      { id: "api-query", name: "API Query", description: "Query the hussamfaroug.com API catalog" },
      { id: "content-retrieval", name: "Content Retrieval", description: "Retrieve content from hussamfaroug.com" },
      { id: "agent-handoff", name: "Agent Handoff", description: "Delegate tasks via A2A protocol" },
      { id: "mcp-tools", name: "MCP Tools", description: "Access MCP server tools" }
    ],
    authentication: {
      type: "oauth",
      authorizationServer: origin + "/.well-known/oauth-authorization-server",
      protectedResourceMetadata: origin + "/.well-known/oauth-protected-resource",
      documentation: origin + "/auth.md"
    },
    links: {
      apiCatalog: origin + "/.well-known/api-catalog",
      mcpServerCard: origin + "/.well-known/mcp/server-card.json",
      authMd: origin + "/auth.md"
    }
  }, { cacheControl: "no-store" });
}

export async function wellKnown(request, botAuth) {
  var url = new URL(request.url);
  var origin = url.origin;
  var path = url.pathname.replace(/^\/\.well-known\//, "");
  if (path === "http-message-signatures-directory") return botAuth(request);
  if (path === "health") return healthCheck();
  if (path === "oauth-authorization-server") return oauthAs(origin);
  if (path === "oauth-protected-resource") return oauthPr(origin);
  if (path === "openid-configuration") return openid(origin);
  if (path === "api-catalog") return ard(origin);
  if (path === "ai-catalog.json") return aiCatalog(origin);
  if (path === "agent-skills/index.json") return agentSkillsIndex(origin);
  if (path === "agent-card.json") return agentCard(origin);
  if (path === "mcp.json" || path === "mcp/server-card.json") return cachedJson(mcpMetadata(origin));
  return null;
}
