import { discoveryLinks, SITE_INFO_TOOL } from "./discovery.js";

export const PUBLIC_CACHE_CONTROL = "public, max-age=3600";

export function b64u(bytes) {
  var binary = "";
  for (var i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function cachedJson(data, options = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": options.contentType || "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": options.cacheControl || PUBLIC_CACHE_CONTROL
    }
  });
}

// CSP helpers operate on an array of trimmed, non-empty directive strings.
// Directive names are matched case-insensitively.
export function parseCSPDirectives(cspHeader) {
  if (!cspHeader) return [];
  return cspHeader.split(";").map(directive => directive.trim()).filter(Boolean);
}

export function getDirectiveIndex(directives, directiveName) {
  const name = directiveName.toLowerCase();
  return directives.findIndex(directive => directive.split(/\s+/, 1)[0].toLowerCase() === name);
}

export function getDirectiveSources(directives, directiveName) {
  const index = getDirectiveIndex(directives, directiveName);
  return index < 0 ? [] : directives[index].split(/\s+/).slice(1);
}

// Replaces the directive's sources (deduplicated, order preserved) or appends it.
// An existing directive keeps its original name spelling.
export function setDirectiveSources(directives, directiveName, sources) {
  const index = getDirectiveIndex(directives, directiveName);
  const name = index >= 0 ? directives[index].split(/\s+/, 1)[0] : directiveName;
  const directive = [name, ...new Set(sources)].join(" ");
  if (index >= 0) directives[index] = directive;
  else directives.push(directive);
  return directives;
}

// Adds the Worker's nonce and Turnstile sources to the origin's effective script
// directive without loosening it: script-src-elem wins over script-src; existing
// sources are kept as-is; script-src is only created (inheriting default-src)
// when neither exists.
export function mergeWorkerScriptSources(cspHeader, workerSources) {
  if (cspHeader.includes(",")) {
    return cspHeader.split(",").map(policy => mergeWorkerScriptSources(policy, workerSources)).join(", ");
  }
  const directives = parseCSPDirectives(cspHeader);
  const target = getDirectiveIndex(directives, "script-src-elem") >= 0 ? "script-src-elem" : "script-src";
  const base = getDirectiveIndex(directives, target) >= 0
    ? getDirectiveSources(directives, target)
    : getDirectiveSources(directives, "default-src");
  setDirectiveSources(directives, target, [...base, ...workerSources]);
  return directives.join("; ");
}

export function secHdrs(headers, nonce) {
  const originCsp = headers.get("Content-Security-Policy");
  if (parseCSPDirectives(originCsp).length) {
    const workerSources = ["'nonce-" + nonce + "'", "https://challenges.cloudflare.com"];
    headers.set("Content-Security-Policy", mergeWorkerScriptSources(originCsp, workerSources));
  } else {
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-" + nonce + "' https://challenges.cloudflare.com ; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests");
  }
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
  const tool = JSON.stringify(SITE_INFO_TOOL).replace(/</g, "\\u003c");
  return '<script nonce="' + escapeHtml(nonce) + '">(function(){if(navigator.modelContext&&navigator.modelContext.provideContext){var tool=' + tool + ';tool.execute=async function(){return{name:"hussamfaroug.com",url:location.origin};};navigator.modelContext.provideContext({tools:[tool]});}})();<\/script>';
}

export function linkHdr(origin) {
  return discoveryLinks(origin).map(link => "<" + link.href + '>; rel="' + link.rel + '"; type="' + link.type + '"').join(", ");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function discoveryHtml(origin) {
  return discoveryLinks(origin).map(link => '<link rel="' + escapeHtml(link.rel) + '" href="' + escapeHtml(link.href) + '" type="' + escapeHtml(link.type) + '" />').join("");
}
