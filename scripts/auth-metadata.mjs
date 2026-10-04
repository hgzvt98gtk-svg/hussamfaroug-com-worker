const EXPECTED_AGENT_AUTH_KEYS = [
  "credential_types_supported",
  "identity_types_supported",
  "register_uri"
];

export function validateAuthMetadataChain({ origin, protectedResource, authorizationServer, authMarkdown }) {
  const issues = [];
  if (protectedResource?.resource !== origin) {
    issues.push("protected resource identifier does not match the site origin");
  }
  if (!Array.isArray(protectedResource?.authorization_servers) ||
      protectedResource.authorization_servers.length !== 1 ||
      protectedResource.authorization_servers[0] !== origin) {
    issues.push("protected resource authorization server does not match the site origin");
  }
  if (protectedResource?.resource_documentation !== origin + "/auth.md") {
    issues.push("protected resource documentation does not link to root /auth.md");
  }
  if (authorizationServer?.issuer !== origin) {
    issues.push("authorization server issuer does not match the site origin");
  }

  const agentAuth = authorizationServer?.agent_auth;
  if (!agentAuth || typeof agentAuth !== "object" || Array.isArray(agentAuth)) {
    issues.push("authorization server is missing the agent_auth object");
  } else {
    const keys = Object.keys(agentAuth).sort();
    if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_AGENT_AUTH_KEYS)) {
      issues.push("agent_auth must contain only register_uri and the supported identity/credential type lists");
    }
    if (agentAuth.register_uri !== origin + "/auth.md#agent-registration") {
      issues.push("agent_auth.register_uri does not link to the root manual registration instructions");
    }
    if (!Array.isArray(agentAuth.identity_types_supported) || agentAuth.identity_types_supported.length !== 0) {
      issues.push("agent_auth must not advertise unsupported identity types");
    }
    if (!Array.isArray(agentAuth.credential_types_supported) || agentAuth.credential_types_supported.length !== 0) {
      issues.push("agent_auth must not advertise unsupported credential types");
    }
  }
  if (authorizationServer && (
    Object.hasOwn(authorizationServer, "claim_endpoint") ||
    Object.hasOwn(authorizationServer, "revocation_endpoint")
  )) {
    issues.push("authorization server must omit unimplemented claim and revocation endpoints");
  }

  for (const [description, pattern] of [
    ["an Agent registration section", /^## Agent registration$/m],
    ["manual-only registration instructions", /registration is manual only/i],
    ["a warning not to POST registration requests", /do not POST registration requests/i],
    ["the absence of automated identity and credential support", /identity_types_supported is empty[\s\S]*credential_types_supported is empty/i],
    ["the absence of claim and revocation APIs", /no registration, claim, or revocation API exists/i],
    ["an explanation that claim and revocation URLs are omitted", /Claim and revocation URLs are omitted/i]
  ]) {
    if (typeof authMarkdown !== "string" || !pattern.test(authMarkdown)) {
      issues.push("root /auth.md is missing " + description);
    }
  }

  return issues;
}
