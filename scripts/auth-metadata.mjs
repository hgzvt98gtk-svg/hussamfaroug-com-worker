const EXPECTED_AGENT_AUTH_KEYS = [
  "credential_types_supported",
  "identity_types_supported",
  "register_uri",
  "skill"
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
      issues.push("agent_auth must contain only skill, register_uri and the supported identity/credential type lists");
    }
    if (agentAuth.skill !== origin + "/auth.md") {
      issues.push("agent_auth.skill does not link to root /auth.md");
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
  const unsupportedAuthorizationServerFields = [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "grant_types_supported",
    "response_types_supported",
    "scopes_supported",
    "token_endpoint_auth_methods_supported",
    "registration_endpoint",
    "claim_endpoint",
    "revocation_endpoint"
  ];
  if (authorizationServer && unsupportedAuthorizationServerFields.some(field =>
    Object.hasOwn(authorizationServer, field))) {
    issues.push("authorization server metadata must not advertise unimplemented OAuth, registration, claim or revocation services");
  }
  if (protectedResource && Object.hasOwn(protectedResource, "scopes_supported")) {
    issues.push("protected resource metadata must not advertise unsupported OAuth scopes");
  }

  const markdown = typeof authMarkdown === "string" ? authMarkdown : "";
  const registration = markdown.match(
    /^#{1,6}[ \t]+agent registration[ \t]*#*[ \t]*\r?\n([\s\S]*?)(?=^#{1,6}[ \t]+|(?![\s\S]))/im
  )?.[1];
  if (!registration) {
    issues.push("root /auth.md is missing an Agent registration section");
  } else if (!/\bmanual(?:ly)?\b/i.test(registration) ||
      !/mailto:[^\s<>]+@[^\s<>]+/i.test(registration)) {
    issues.push("root /auth.md is missing manual registration contact instructions");
  }
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server"
  ]) {
    if (!markdown.includes(origin + path)) {
      issues.push("root /auth.md is missing the discovery link " + path);
    }
  }
  if (!markdown.includes(origin + "/auth.md#agent-registration")) {
    issues.push("root /auth.md is missing the manual registration link");
  }

  return issues;
}
