// Single source of truth for Worker configuration and discovery metadata.
// This module must not import other Worker modules so it cannot create cycles.

export const WORKER_VERSION = "1.0.0";

export const PUBLIC_CACHE_CONTROL = "public, max-age=3600";

export const CACHE_CONTROL_POLICIES = Object.freeze({
  public_1h: PUBLIC_CACHE_CONTROL,
  private_nostore: "private, no-store",
  nostore: "no-store"
});

export const CONTACT = "admin@hussamfaroug.com";

export const MAX_HTML_BYTES = 1024 * 1024;
export const ORIGIN_TIMEOUT_MS = 10000;
export const ORIGIN_RETRY_BASE_DELAY_MS = 100;
export const MARKDOWN_TIMEOUT_MS = 5000;

export const RATE_LIMIT_REQUESTS_PER_MINUTE = 100;
export const RATE_LIMIT_WINDOW_MS = 60000;
export const RATE_LIMIT_MAX_CLIENTS = 10000;

export const SITE_INFO_TOOL = Object.freeze({
  name: "get_site_info",
  description: "Get the public site name and URL in the browser using WebMCP. Read-only; no HTTP MCP endpoint.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
});

export const DISCOVERY_ENDPOINTS = Object.freeze({
  health: "/.well-known/health",
  openid_config: "/.well-known/openid-configuration",
  oauth_auth_server: "/.well-known/oauth-authorization-server",
  oauth_protected_resource: "/.well-known/oauth-protected-resource",
  mcp_server_card: "/.well-known/mcp/server-card.json",
  api_catalog: "/.well-known/api-catalog",
  agent_card: "/.well-known/agent-card.json",
  ai_catalog: "/.well-known/ai-catalog.json",
  agent_skills: "/.well-known/agent-skills/",
  agent_skills_index: "/.well-known/agent-skills/index.json",
  site_info_skill: "/.well-known/agent-skills/" + SITE_INFO_TOOL.name + "/SKILL.md",
  http_message_signatures_directory: "/.well-known/http-message-signatures-directory",
  auth_md: "/auth.md"
});
