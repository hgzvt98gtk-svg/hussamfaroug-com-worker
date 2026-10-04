// Shared Auth.md discovery chain invariants:
// /.well-known/oauth-protected-resource -> /.well-known/oauth-authorization-server -> /auth.md.
// Used by the unit tests and the post-deployment verifier so a stale or
// malformed production response fails loudly instead of passing a presence check.

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
export const AUTH_MD_PATH = "/auth.md";
export const REGISTRATION_FRAGMENT = "#agent-registration";

const AGENT_AUTH_KEYS = [
  "anonymous", "credential_types_supported", "identity_types_supported", "register_uri", "skill"
];
// No claim, revocation, identity, or event service is implemented, so none may be advertised.
const UNIMPLEMENTED_KEYS = [
  "claim_uri", "claim_endpoint", "claim_complete_uri", "revocation_uri", "revocation_endpoint",
  "identity_endpoint", "events_endpoint", "events_supported", "registration_endpoint"
];
const AUTH_MD_MARKERS = [
  "You are an agent", "**agentic registration**", "agent_auth", "register_uri", "skill",
  "identity_types_supported", "credential_types_supported"
];

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isStringList = value => Array.isArray(value) && value.length > 0 &&
  value.every(item => typeof item === "string" && item.length > 0);

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function headingSlug(text) {
  return text.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

export function validateProtectedResource(prm, origin) {
  if (!isObject(prm)) return ["protected resource metadata is not a JSON object"];
  const issues = [];
  if (prm.resource !== origin) issues.push(`resource must be ${origin}`);
  if (!isStringList(prm.authorization_servers)) {
    issues.push("authorization_servers must be a non-empty array of URLs");
  } else if (!prm.authorization_servers.every(server => server === origin)) {
    issues.push(`authorization_servers must share the resource origin ${origin}`);
  }
  if (!isStringList(prm.scopes_supported)) issues.push("scopes_supported must be a non-empty array");
  if (!Array.isArray(prm.bearer_methods_supported) || !prm.bearer_methods_supported.includes("header")) {
    issues.push("bearer_methods_supported must include header");
  }
  if (prm.resource_documentation !== origin + AUTH_MD_PATH) {
    issues.push(`resource_documentation must be ${origin}${AUTH_MD_PATH}`);
  }
  return issues;
}

export function validateAuthorizationServer(as, origin) {
  if (!isObject(as)) return ["authorization server metadata is not a JSON object"];
  const issues = [];
  if (as.issuer !== origin) issues.push(`issuer must be ${origin}`);
  for (const key of UNIMPLEMENTED_KEYS) {
    if (key in as) issues.push(`${key} advertises an unimplemented service`);
  }
  const agentAuth = as.agent_auth;
  if (!isObject(agentAuth)) return [...issues, "agent_auth block is missing"];
  const keys = Object.keys(agentAuth).sort();
  for (const key of keys) {
    if (UNIMPLEMENTED_KEYS.includes(key)) issues.push(`agent_auth.${key} advertises an unimplemented service`);
    else if (!AGENT_AUTH_KEYS.includes(key)) issues.push(`agent_auth.${key} is not a supported field`);
  }
  if (agentAuth.skill !== origin + AUTH_MD_PATH) issues.push(`agent_auth.skill must be ${origin}${AUTH_MD_PATH}`);
  if (agentAuth.register_uri !== origin + AUTH_MD_PATH + REGISTRATION_FRAGMENT) {
    issues.push(`agent_auth.register_uri must be ${origin}${AUTH_MD_PATH}${REGISTRATION_FRAGMENT}`);
  }
  if (!isStringList(agentAuth.identity_types_supported)) {
    issues.push("agent_auth.identity_types_supported must be a non-empty array");
  }
  if (!isStringList(agentAuth.credential_types_supported)) {
    issues.push("agent_auth.credential_types_supported must be a non-empty array");
  }
  const identityTypes = Array.isArray(agentAuth.identity_types_supported) ? agentAuth.identity_types_supported : [];
  if (identityTypes.includes("anonymous")) {
    if (!isObject(agentAuth.anonymous) || !isStringList(agentAuth.anonymous.credential_types_supported)) {
      issues.push("agent_auth.anonymous.credential_types_supported must be a non-empty array");
    } else {
      for (const key of Object.keys(agentAuth.anonymous)) {
        if (key !== "credential_types_supported") issues.push(`agent_auth.anonymous.${key} is not a supported field`);
      }
    }
  } else if ("anonymous" in agentAuth) {
    issues.push("agent_auth.anonymous requires anonymous in identity_types_supported");
  }
  return issues;
}

export function validateAuthMd(text, origin) {
  if (typeof text !== "string" || !text) return ["auth.md is empty"];
  const issues = [];
  if (!/^# [^\n]*auth\.md/.test(text)) issues.push("auth.md must start with an H1 containing auth.md");
  for (const marker of AUTH_MD_MARKERS) {
    if (!text.includes(marker)) issues.push(`auth.md is missing marker ${marker}`);
  }
  for (const path of [PROTECTED_RESOURCE_PATH, AUTHORIZATION_SERVER_PATH]) {
    if (!text.includes(origin + path)) issues.push(`auth.md does not link ${origin}${path}`);
  }
  const anchors = [...text.matchAll(/^#{1,6} (.+)$/gm)].map(match => "#" + headingSlug(match[1]));
  if (!anchors.includes(REGISTRATION_FRAGMENT)) issues.push(`auth.md has no ${REGISTRATION_FRAGMENT} heading`);
  return issues;
}

// Validates each document and the links between them. `origin` is the scanned site origin.
export function validateAuthDiscoveryChain({ origin, protectedResource, authorizationServer, authMd }) {
  const siteOrigin = originOf(origin);
  if (!siteOrigin) return ["origin is not a valid URL"];
  const issues = validateProtectedResource(protectedResource, siteOrigin)
    .map(issue => PROTECTED_RESOURCE_PATH + ": " + issue);
  const server = isObject(protectedResource) && Array.isArray(protectedResource.authorization_servers)
    ? protectedResource.authorization_servers[0] : undefined;
  if (isObject(authorizationServer) && server !== undefined && authorizationServer.issuer !== server) {
    issues.push(`${AUTHORIZATION_SERVER_PATH}: issuer does not match authorization_servers[0] from ${PROTECTED_RESOURCE_PATH}`);
  }
  issues.push(...validateAuthorizationServer(authorizationServer, siteOrigin)
    .map(issue => AUTHORIZATION_SERVER_PATH + ": " + issue));
  issues.push(...validateAuthMd(authMd, siteOrigin).map(issue => AUTH_MD_PATH + ": " + issue));
  return issues;
}
