var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var O = "https://hgzvt98gtk-svg-github-io.pages.dev";
var C = "admin@hussamfaroug.com";
var encoder = new TextEncoder();
var PUBLIC_CACHE_CONTROL = "public, max-age=3600";
function b64u(b) {
  return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64u, "b64u");
function cachedJson(data, contentType) {
  return new Response(JSON.stringify(data, null, 2), { headers: {
    "Content-Type": contentType || "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": PUBLIC_CACHE_CONTROL
  } });
}
__name(cachedJson, "cachedJson");
async function botAuth(req, env) {
  var o = new URL(req.url).origin;
  var kv = env && env.SITE_CONFIG;
  var pubJwkStr = null, privJwkStr = null;
  try {
    if (kv) {
      [pubJwkStr, privJwkStr] = await Promise.all([
        kv.get("BOT_AUTH_PUBKEY_JWK"),
        kv.get("BOT_AUTH_PRIVKEY_JWK")
      ]);
    }
  } catch (e) {
  }
  var ck, pubJwk;
  if (pubJwkStr && privJwkStr) {
    pubJwk = JSON.parse(pubJwkStr);
    ck = await crypto.subtle.importKey("jwk", JSON.parse(privJwkStr), { name: "Ed25519" }, false, ["sign"]);
  } else {
    var kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    ck = kp.privateKey;
    pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    var privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    pubJwkStr = JSON.stringify(pubJwk);
    privJwkStr = JSON.stringify(privJwk);
    try {
      if (kv) {
        await Promise.all([
          kv.put("BOT_AUTH_PUBKEY_JWK", pubJwkStr),
          kv.put("BOT_AUTH_PRIVKEY_JWK", privJwkStr)
        ]);
      }
    } catch (e) {
    }
  }
  var x = pubJwk.x;
  var th = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })))));
  var j = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid: th, x, alg: "EdDSA" }] });
  var h = new URL(req.url).host, cr = Math.floor(Date.now() / 1e3), ex = cr + 300;
  var si = 'sig1=("@authority" "signature-agent");created=' + cr + ';keyid="' + th + '";alg="ed25519";expires=' + ex + ';tag="web-bot-auth"';
  var sb = '"@authority": ' + h + '\n"signature-agent": ' + o + '\n"@created": ' + cr + '\n"@expires": ' + ex;
  var sg = btoa(String.fromCharCode.apply(null, new Uint8Array(await crypto.subtle.sign("Ed25519", ck, encoder.encode(sb)))));
  return new Response(j, { headers: {
    "Content-Type": "application/http-message-signatures-directory+json",
    "Access-Control-Allow-Origin": "*",
    "Signature-Agent": '"' + o + '"',
    "Signature-Input": si,
    "Signature": "sig1=:" + sg + ":",
    "Cache-Control": PUBLIC_CACHE_CONTROL
  } });
}
__name(botAuth, "botAuth");
function agentAuthMetadata(o) {
  return {
    register_uri: o + "/agent/auth",
    identity_types_supported: ["identity_assertion", "anonymous"],
    credential_types_supported: ["client_secret", "private_key_jwt", "signed_http_request"],
    authorization_endpoint: o + "/oauth/authorize",
    token_endpoint: o + "/token",
    revocation_uri: o + "/agent/revoke",
    claim_uri: o + "/agent/claims",
    documentation_uri: o + "/auth.md"
  };
}
__name(agentAuthMetadata, "agentAuthMetadata");
function authMd(o) {
  var tb = String.fromCharCode(96, 96, 96);
  return new Response([
    "# auth.md",
    "",
    "You are an agent. This document tells you how to register a credential for hussamfaroug.com.",
    "",
    "## Agent Authentication",
    "",
    tb + "json",
    JSON.stringify({
      agent_auth: agentAuthMetadata(o)
    }, null, 2),
    tb,
    "",
    "",
    "## Step 1 - Register",
    "",
    "POST to the registration endpoint with your desired client metadata:",
    "",
    tb + "http",
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
    tb,
    "",
    "",
    "## Step 2 - Authorize",
    "",
    "Open the authorization endpoint in a browser:",
    "",
    tb,
    o + "/oauth/authorize?response_type=code&client_id=agent-1234567890&redirect_uri=https://my-agent.example.com/callback&scope=agent:register&code_challenge=<PKCE_CHALLENGE>&code_challenge_method=S256",
    tb,
    "",
    "",
    "## Step 3 - Exchange code for token",
    "",
    tb + "http",
    "POST /token HTTP/1.1",
    "Host: hussamfaroug.com",
    "Content-Type: application/x-www-form-urlencoded",
    "",
    "grant_type=authorization_code&code=<code>&redirect_uri=https://my-agent.example.com/callback&code_verifier=<PKCE_VERIFIER>",
    tb,
    "",
    "",
    "## Step 4 - Use the token",
    "",
    tb + "http",
    "GET / HTTP/1.1",
    "Host: hussamfaroug.com",
    "Authorization: Bearer <access_token>",
    tb,
    "",
    "",
    "## Endpoints",
    "",
    "- register_uri: " + o + "/agent/auth",
    "- authorization_endpoint: " + o + "/oauth/authorize",
    "- token_endpoint: " + o + "/token",
    "- revocation_uri: " + o + "/agent/revoke",
    "- claim_uri: " + o + "/agent/claims",
    "- jwks_uri: " + o + "/.well-known/http-message-signatures-directory",
    "",
    "Contact: " + C,
    ""
  ].join("\n"), { headers: {
    "Content-Type": "text/markdown",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": PUBLIC_CACHE_CONTROL
  } });
}
__name(authMd, "authMd");
function oauthAs(o) {
  return cachedJson({
    issuer: o,
    authorization_endpoint: o + "/oauth/authorize",
    token_endpoint: o + "/token",
    registration_endpoint: o + "/agent/auth",
    revocation_endpoint: o + "/agent/revoke",
    jwks_uri: o + "/.well-known/http-message-signatures-directory",
    scopes_supported: ["read", "write", "agent:register"],
    response_types_supported: ["code", "token"],
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    agent_auth: agentAuthMetadata(o),
    documentation: o + "/auth.md"
  });
}
__name(oauthAs, "oauthAs");
function oauthPr(o) {
  return cachedJson({
    resource: o,
    authorization_servers: [o],
    scopes_supported: ["read", "write", "agent:register"],
    bearer_methods_supported: ["header"],
    resource_documentation: o + "/auth.md",
    jwks_uri: o + "/.well-known/http-message-signatures-directory",
    agent_auth: agentAuthMetadata(o)
  });
}
__name(oauthPr, "oauthPr");
function openid(o) {
  return cachedJson({
    issuer: o,
    authorization_endpoint: o + "/oauth/authorize",
    token_endpoint: o + "/token",
    userinfo_endpoint: o + "/agent/claims",
    jwks_uri: o + "/.well-known/http-message-signatures-directory",
    response_types_supported: ["code", "token", "id_token"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["read", "write", "agent:register"],
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    claims_supported: ["sub", "email", "email_verified", "name", "groups"]
  });
}
__name(openid, "openid");
function mcpMetadata(o) {
  return {
    serverInfo: { name: "hussamfaroug.com", version: "1.0.0" },
    transport: { type: "http", url: o + "/.well-known/mcp" },
    capabilities: { tools: true, resources: true, prompts: false },
    tools: [{ name: "get_site_info", description: "Get information about hussamfaroug.com", inputSchema: { type: "object", properties: {} } }]
  };
}
__name(mcpMetadata, "mcpMetadata");
function mcpJson(o) {
  return cachedJson(mcpMetadata(o));
}
__name(mcpJson, "mcpJson");
function ard(o) {
  return cachedJson({
    linkset: [
      { anchor: o, href: o + "/.well-known/mcp/server-card.json", rel: "service-meta", type: "application/vnd.mcp.server+json", title: "HussamFaroug MCP Server", description: "MCP server for hussamfaroug.com" },
      { anchor: o, href: o + "/.well-known/agent-card.json", rel: "agent", type: "application/vnd.a2a.agent+json", title: "HussamFaroug A2A Agent", description: "A2A-compatible AI agent for hussamfaroug.com" },
      { anchor: o, href: o + "/.well-known/oauth-authorization-server", rel: "service-desc", type: "application/json", title: "OAuth Authorization Server", description: "OAuth authorization server metadata" },
      { anchor: o, href: o + "/auth.md", rel: "service-doc", type: "text/markdown", title: "Agent Auth Documentation", description: "How to register a credential for hussamfaroug.com" },
      { anchor: o, href: o + "/.well-known/health", rel: "status", type: "application/json", title: "Health Check", description: "Service health endpoint" }
    ]
  }, "application/linkset+json");
}
__name(ard, "ard");
function aiCatalog(o) {
  return cachedJson({
    specVersion: "0.1.0",
    host: { name: "hussamfaroug.com", description: "Personal website for Hussam Faroug - AI agent-ready", url: o },
    entries: [
      { identifier: "urn:air:hussamfaroug.com:mcp:server", displayName: "HussamFaroug MCP Server", type: "application/vnd.mcp.server+json", url: o + "/.well-known/mcp/server-card.json", description: "MCP server for hussamfaroug.com", representativeQueries: ["what tools does the hussamfaroug MCP server expose", "how do I connect to the hussamfaroug MCP server", "what is the MCP server card for hussamfaroug.com"] },
      { identifier: "urn:air:hussamfaroug.com:a2a:agent", displayName: "HussamFaroug A2A Agent", type: "application/vnd.a2a.agent+json", url: o + "/.well-known/agent-card.json", description: "A2A-compatible AI agent for hussamfaroug.com", representativeQueries: ["what is the agent card for hussamfaroug.com", "how do I interact with the hussamfaroug agent"] },
      { identifier: "urn:air:hussamfaroug.com:auth", displayName: "HussamFaroug Auth", type: "application/json", url: o + "/.well-known/oauth-authorization-server", description: "OAuth authorization server metadata for hussamfaroug.com", representativeQueries: ["how do I authenticate with hussamfaroug.com", "what OAuth endpoints does hussamfaroug.com support"] }
    ]
  });
}
__name(aiCatalog, "aiCatalog");
function agentSkillsIndex(o) {
  return cachedJson({
    $schema: "https://agentskills.io/schemas/agent-skills-index.v0.2.json",
    skills: [
      { name: "get_site_info", type: "tool", description: "Get information about hussamfaroug.com", url: o + "/.well-known/agent-skills/get_site_info/SKILL.md", sha256: "0000000000000000000000000000000000000000000000000000000000000000" },
      { name: "agent_auth", type: "skill", description: "Register a credential for hussamfaroug.com", url: o + "/auth.md", sha256: "0000000000000000000000000000000000000000000000000000000000000000" }
    ]
  });
}
__name(agentSkillsIndex, "agentSkillsIndex");
function healthCheck() {
  return new Response(JSON.stringify({ status: "ok", timestamp: (new Date()).toISOString() }, null, 2), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
}
__name(healthCheck, "healthCheck");
function agentCard(o) {
  return new Response(JSON.stringify({
    schemaVersion: "1.0",
    name: "HussamFaroug Agent",
    version: "1.0.0",
    description: "AI agent for hussamfaroug.com providing API access, content retrieval, and agent-to-agent communication.",
    url: o + "/a2a",
    protocolVersion: "1.0",
    preferredTransport: "jsonrpc",
    supportedInterfaces: [{
      protocol: "jsonrpc",
      version: "2.0",
      url: o + "/a2a",
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
      authorizationServer: o + "/.well-known/oauth-authorization-server",
      protectedResourceMetadata: o + "/.well-known/oauth-protected-resource",
      documentation: o + "/auth.md"
    },
    links: {
      apiCatalog: o + "/.well-known/api-catalog",
      mcpServerCard: o + "/.well-known/mcp/server-card.json",
      authMd: o + "/auth.md"
    }
  }, null, 2), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
}
__name(agentCard, "agentCard");
function secHdrs(h, n) {
  h.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-" + n + "' https://challenges.cloudflare.com ; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests");
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  h.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.delete("X-XSS-Protection");
  h.delete("Expect-CT");
  return h;
}
__name(secHdrs, "secHdrs");
function webmcp(n) {
  return '<script nonce="' + n + '">(function(){if(navigator.modelContext&&navigator.modelContext.provideContext){navigator.modelContext.provideContext({tools:[{name:"get_site_info",description:"Get information about hussamfaroug.com",inputSchema:{type:"object",properties:{}},execute:async function(){return{name:"hussamfaroug.com",url:location.origin};}}]});}})();<\/script>';
}
__name(webmcp, "webmcp");
function linkHdr(o) {
  return "<" + o + '/.well-known/api-catalog>; rel="api-catalog", <' + o + '/.well-known/agent-card.json>; rel="agent", <' + o + '/.well-known/mcp/server-card.json>; rel="service-meta", <' + o + '/.well-known/oauth-authorization-server>; rel="service-desc", <' + o + '/.well-known/oauth-protected-resource>; rel="service-desc", <' + o + '/auth.md>; rel="service-doc"';
}
__name(linkHdr, "linkHdr");
async function wellKnown(req, env) {
  var u = new URL(req.url);
  var o = u.origin;
  var p = u.pathname.replace(/^\/\.well-known\//, "");
  if (p === "http-message-signatures-directory") return await botAuth(req, env);
  if (p === "oauth-authorization-server") return oauthAs(o);
  if (p === "oauth-protected-resource") return oauthPr(o);
  if (p === "openid-configuration") return openid(o);
  if (p === "api-catalog") return ard(o);
  if (p === "ai-catalog.json") return aiCatalog(o);
  if (p === "agent-skills/index.json") return agentSkillsIndex(o);
  if (p === "health") return healthCheck();
  if (p === "agent-card.json") return agentCard(o);
  if (p === "mcp.json") return mcpJson(o);
  if (p === "mcp/server-card.json") return mcpJson(o);
  return null;
}
__name(wellKnown, "wellKnown");
function mdDec(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, function(m, c) {
    return String.fromCharCode(c);
  });
}
__name(mdDec, "mdDec");
function mdClean(h) {
  return h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
__name(mdClean, "mdClean");
function mdRu(h, b) {
  try {
    return new URL(h, b).href;
  } catch {
    return h;
  }
}
__name(mdRu, "mdRu");
function convertMd(html, url) {
  var t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  t = mdDec(t.trim());
  var b = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<head[\s\S]*?<\/head>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>|<aside[\s\S]*?<\/aside>|<svg[\s\S]*?<\/svg>|<!--[\s\S]*?-->/gi, "");
  var m = b.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i);
  if (m) b = m[2];
  else {
    m = b.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (m) b = m[1];
  }
  var md = "";
  if (t) md += "# " + t + "\n\n";
  b = b.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, function(_, level, content) {
    return "\n\n" + "#".repeat(Number(level)) + " " + mdClean(content) + "\n\n";
  });
  b = b.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, function(_, c) {
    return "\n\n```\n" + mdDec(c.replace(/<[^>]+>/g, "")).trim() + "\n```\n\n";
  });
  b = b.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, function(_, c) {
    return "`" + mdDec(c.replace(/<[^>]+>/g, "")).trim() + "`";
  });
  b = b.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, function(_, c) {
    return "\n\n" + mdClean(c).split("\n").map(function(l) {
      return "> " + l;
    }).join("\n") + "\n\n";
  });
  b = b.replace(/<img[^>]*>/gi, function(m2) {
    var a = (m2.match(/alt=["']([^"']*)["']/i) || [])[1] || "";
    var s = (m2.match(/src=["']([^"']*)["']/i) || [])[1] || "";
    return "![" + mdDec(a) + "](" + mdRu(s, url) + ")";
  });
  b = b.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, function(_, h, c) {
    return "[" + mdClean(c) + "](" + mdRu(h, url) + ")";
  });
  b = b.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, function(_, c) {
    var it = c.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    return "\n\n" + it.map(function(x) {
      return "- " + mdClean(x.replace(/<li[^>]*>|<\/li>/gi, ""));
    }).join("\n") + "\n\n";
  });
  b = b.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, function(_, c) {
    var it = c.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    return "\n\n" + it.map(function(x, i2) {
      return i2 + 1 + ". " + mdClean(x.replace(/<li[^>]*>|<\/li>/gi, ""));
    }).join("\n") + "\n\n";
  });
  b = b.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, function(_, c) {
    return "**" + mdClean(c) + "**";
  });
  b = b.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, function(_, c) {
    return "*" + mdClean(c) + "*";
  });
  b = b.replace(/<hr[^>]*>/gi, "\n\n---\n\n");
  b = b.replace(/<p[^>]*>/gi, "\n\n").replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  b = b.replace(/<[^>]+>/g, "");
  b = mdDec(b);
  b = b.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/^[ \t]+/gm, "").replace(/[ \t]+$/gm, "").trim();
  return md + b;
}
__name(convertMd, "convertMd");
var worker_default = {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
async function handleRequest(req, env) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400"
    } });
  }
  var u = new URL(req.url);
  var o = u.origin;
  var isMaintenance = false;
  try {
    isMaintenance = await env.FLAGS?.getBooleanValue("maintenance-mode", false);
  } catch (e) {
  }
  if (isMaintenance) {
    return new Response("Site under maintenance", { status: 503, headers: { "Content-Type": "text/plain", "Retry-After": "3600" } });
  }
  if (u.pathname.startsWith("/.well-known/")) {
    var wk = await wellKnown(req, env);
    if (wk) return wk;
  }
  if (u.pathname === "/auth.md") return authMd(o);
  var pu = O + u.pathname + u.search;
  var r = await fetch(pu, { method: req.method, headers: req.headers, redirect: "manual" });
  var ct = r.headers.get("Content-Type") || "";
  if (ct.indexOf("text/html") === -1) {
    return new Response(r.body, { status: r.status, headers: r.headers });
  }
  var acceptMd = (req.headers.get("Accept") || "").includes("text/markdown");
  if (acceptMd) {
    var html = await r.text();
    var md = convertMd(html, o);
    var tokens = Math.max(1, Math.ceil(encoder.encode(md).length / 4));
    return new Response(md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "x-markdown-tokens": String(tokens),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
  var h = new Headers(r.headers);
  var nonceBytes = crypto.getRandomValues(new Uint8Array(24));
  var n = b64u(nonceBytes);
  h.set("Link", linkHdr(o));
  h = secHdrs(h, n);
  var hb = await r.text();
  hb = hb.replace(/<script[^>]*src=["'][^"']*\.webmcp\/bridge\.js[^"']*["'][^>]*><\/script>/gi, "");
  var ws = webmcp(n);
  var mh2 = hb.indexOf("</body>") !== -1 ? hb.replace("</body>", ws + "</body>") : hb.indexOf("</head>") !== -1 ? hb.replace("</head>", ws + "</head>") : hb + ws;
  h.set("Content-Length", encoder.encode(mh2).length.toString());
  return new Response(mh2, { status: r.status, headers: h });
}
__name(handleRequest, "handleRequest");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
