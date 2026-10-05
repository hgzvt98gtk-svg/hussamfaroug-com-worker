import { DISCOVERY_ENDPOINTS as E, SITE_INFO_TOOL } from "./constants.js";

export { SITE_INFO_TOOL };

const LINKS = [
  { path: E.openid_config, rel: "service-meta", type: "application/json", title: "OpenID Connect Discovery", description: "Phase 1 authentication discovery metadata" },
  { path: E.oauth_auth_server, rel: "oauth-authorization-server", type: "application/json", title: "OAuth Authorization Server Discovery", description: "Issuer and manual agent registration metadata; no OAuth service is implemented" },
  { path: E.oauth_protected_resource, rel: "oauth-protected-resource", type: "application/json", title: "OAuth Protected Resource Metadata", description: "Public resource identifier, discovery link, and documentation" },
  { path: E.mcp_server_card, rel: "service-meta", type: "application/json", title: "Browser MCP Server Card", description: "Browser-only WebMCP capabilities and tool input schemas" },
  { path: E.api_catalog, rel: "api-catalog", type: "application/linkset+json", title: "Public API Linkset", description: "Links to implemented public discovery resources" },
  { path: E.agent_card, rel: "agent", type: "application/json", title: "Public Site Metadata", description: "Public site information, not an agent-to-agent service" },
  { path: E.ai_catalog, rel: "service-meta", type: "application/json", title: "Public Resource Catalog", description: "Catalog of implemented public site resources" },
  { path: E.agent_skills_index, rel: "service-meta", type: "application/json", title: "Browser Skills Index", description: "Browser-only WebMCP tool documentation" },
  { path: E.site_info_skill, rel: "service-doc", type: "text/markdown", title: SITE_INFO_TOOL.name, description: SITE_INFO_TOOL.description },
  { path: E.auth_md, rel: "service-doc", type: "text/markdown", title: "Agent Authentication Documentation", description: "Public access, Phase 1 OAuth discovery, registration contact, and signature verification" },
  { path: E.health, rel: "status", type: "application/json", title: "Health Check", description: "Worker health endpoint" },
  { path: E.http_message_signatures_directory, rel: "service-meta", type: "application/json", title: "HTTP Message Signature Directory", description: "Public verification keys for HTTP message signatures; not authentication registration" }
];

export function discoveryLinks(origin) {
  return LINKS.map(({ path, ...link }) => ({ anchor: origin, href: origin + path, ...link }));
}

export function isLegacyDiscoveryPath(pathname) {
  if ([
    E.openid_config,
    E.oauth_auth_server,
    E.oauth_protected_resource,
    E.mcp_server_card
  ].includes(pathname)) return false;
  return /^\/\.well-known\/(?:oauth-authorization-server|oauth-protected-resource|openid-configuration|mcp(?:\.json)?|agent\.json)(?:\/|$)/.test(pathname)
    || /^\/(?:a2a|mcp|oauth|token)(?:\/|$)/.test(pathname)
    || /^\/agent\/(?:auth|revoke|claims)(?:\/|$)/.test(pathname);
}
