export const SITE_INFO_TOOL = Object.freeze({
  name: "get_site_info",
  description: "Get the public site name and URL in the browser using WebMCP. Read-only; no HTTP MCP endpoint.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
});

const LINKS = [
  { path: "/.well-known/api-catalog", rel: "api-catalog", type: "application/linkset+json", title: "Public API Linkset", description: "Links to implemented public discovery resources" },
  { path: "/.well-known/agent-card.json", rel: "agent", type: "application/json", title: "Public Site Metadata", description: "Public site information, not an agent-to-agent service" },
  { path: "/.well-known/ai-catalog.json", rel: "service-meta", type: "application/json", title: "Public Resource Catalog", description: "Catalog of implemented public site resources" },
  { path: "/.well-known/agent-skills/index.json", rel: "service-meta", type: "application/json", title: "Browser Skills Index", description: "Browser-only WebMCP tool documentation" },
  { path: "/.well-known/agent-skills/get_site_info/SKILL.md", rel: "service-doc", type: "text/markdown", title: "get_site_info", description: SITE_INFO_TOOL.description },
  { path: "/auth.md", rel: "service-doc", type: "text/markdown", title: "Public Access Documentation", description: "Public read-only access and HTTP message signature directory" },
  { path: "/.well-known/health", rel: "status", type: "application/json", title: "Health Check", description: "Worker health endpoint" },
  { path: "/.well-known/http-message-signatures-directory", rel: "service-meta", type: "application/json", title: "HTTP Message Signature Directory", description: "Public verification keys for HTTP message signatures; not authentication registration" }
];

export function discoveryLinks(origin) {
  return LINKS.map(({ path, ...link }) => ({ anchor: origin, href: origin + path, ...link }));
}

export function isLegacyDiscoveryPath(pathname) {
  return /^\/\.well-known\/(?:oauth-authorization-server|oauth-protected-resource|openid-configuration|mcp(?:\.json)?|agent\.json)(?:\/|$)/.test(pathname)
    || /^\/(?:a2a|mcp|oauth|token)(?:\/|$)/.test(pathname)
    || /^\/agent\/(?:auth|revoke|claims)(?:\/|$)/.test(pathname);
}
