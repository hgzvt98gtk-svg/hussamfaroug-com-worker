export const PUBLIC_CACHE_CONTROL = "public, max-age=3600";

export function cachedJson(data, options = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": options.contentType || "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": options.cacheControl || PUBLIC_CACHE_CONTROL
    }
  });
}

export function secHdrs(headers, nonce) {
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-" + nonce + "' https://challenges.cloudflare.com ; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.delete("X-XSS-Protection");
  headers.delete("Expect-CT");
  return headers;
}

export function varyAccept(headers) {
  const vary = headers.get("Vary");
  if (!vary) {
    headers.set("Vary", "Accept");
  } else if (vary.trim() !== "*" && !vary.split(",").some(value => value.trim().toLowerCase() === "accept")) {
    headers.set("Vary", vary + ", Accept");
  }
  return headers;
}

export function webmcp(nonce) {
  return '<script nonce="' + nonce + '">(function(){if(navigator.modelContext&&navigator.modelContext.provideContext){navigator.modelContext.provideContext({tools:[{name:"get_site_info",description:"Get information about hussamfaroug.com",inputSchema:{type:"object",properties:{}},execute:async function(){return{name:"hussamfaroug.com",url:location.origin};}}]});}})();<\/script>';
}

export function linkHdr(origin) {
  return "<" + origin + '/.well-known/api-catalog>; rel="api-catalog", <' + origin + '/.well-known/agent-card.json>; rel="agent", <' + origin + '/.well-known/mcp/server-card.json>; rel="service-meta", <' + origin + '/.well-known/oauth-authorization-server>; rel="service-desc", <' + origin + '/.well-known/oauth-protected-resource>; rel="service-desc", <' + origin + '/auth.md>; rel="service-doc"';
}
