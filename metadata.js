import { cachedJson, PUBLIC_CACHE_CONTROL } from "./response.js";
import { discoveryLinks, isLegacyDiscoveryPath, SITE_INFO_TOOL } from "./discovery.js";

export { isLegacyDiscoveryPath } from "./discovery.js";

const CONTACT = "admin@hussamfaroug.com";

function markdownResponse(text) {
  return new Response(text, {
    headers: {
      "Content-Type": "text/markdown",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": PUBLIC_CACHE_CONTROL
    }
  });
}

export function authMd(origin) {
  return markdownResponse([
    "# Public access",
    "",
    "This is Hussam Faroug's public, read-only website. No credentials or bearer tokens are required to read its public content and discovery metadata.",
    "",
    "There is no credential registration, OAuth authorization server, OpenID Connect provider, or agent-to-agent service.",
    "",
    "## Browser tool",
    "",
    SITE_INFO_TOOL.description,
    "The tool is registered only in browsers that support navigator.modelContext.provideContext. It is not an HTTP service.",
    "",
    "## HTTP message signature directory",
    "",
    "Public verification keys are available at " + origin + "/.well-known/http-message-signatures-directory when signing is configured.",
    "These keys describe HTTP message signatures, not user identity, OAuth tokens, or credential registration. The directory does not grant access or authenticate visitors.",
    "",
    "Public resource links: " + origin + "/.well-known/api-catalog",
    "",
    "Contact: " + CONTACT,
    ""
  ].join("\n"));
}

function apiCatalog(origin) {
  return cachedJson({ linkset: discoveryLinks(origin) }, { contentType: "application/linkset+json" });
}

function aiCatalog(origin) {
  return cachedJson({
    specVersion: "0.1.0",
    host: { name: "hussamfaroug.com", description: "Hussam Faroug's public, read-only personal website", url: origin },
    entries: discoveryLinks(origin).map(link => ({
      identifier: "urn:site:hussamfaroug.com:" + new URL(link.href).pathname,
      displayName: link.title,
      type: link.type,
      url: link.href,
      description: link.description
    }))
  });
}

function agentSkillsIndex(origin) {
  return cachedJson({
    $schema: "https://agentskills.io/schemas/agent-skills-index.v0.2.json",
    skills: [{
      name: SITE_INFO_TOOL.name,
      type: "tool",
      description: SITE_INFO_TOOL.description,
      url: origin + "/.well-known/agent-skills/get_site_info/SKILL.md",
      execution: "browser-only"
    }]
  });
}

function siteInfoSkill(origin) {
  return markdownResponse([
    "---",
    "name: " + SITE_INFO_TOOL.name,
    "description: " + SITE_INFO_TOOL.description,
    "---",
    "",
    "# get_site_info",
    "",
    "On " + origin + ", a supporting browser registers this read-only tool through navigator.modelContext.provideContext.",
    "Input: an empty object. Output: the site name (hussamfaroug.com) and the current browser location.origin.",
    "This tool executes in the browser. No HTTP MCP endpoint, server transport, credentials, or network request is provided.",
    ""
  ].join("\n"));
}

function agentCard(origin) {
  return cachedJson({
    name: "HussamFaroug Agent",
    version: "1.0.0",
    description: "Public discovery metadata for Hussam Faroug's read-only personal website. This is not an agent-to-agent service.",
    url: origin,
    capabilities: { publicReadOnly: true, browserTools: [SITE_INFO_TOOL.name] },
    tools: [{ ...SITE_INFO_TOOL, execution: "browser-only" }],
    links: {
      apiCatalog: origin + "/.well-known/api-catalog",
      skillsIndex: origin + "/.well-known/agent-skills/index.json",
      authMd: origin + "/auth.md"
    }
  }, { cacheControl: "no-store" });
}

export async function wellKnown(request, botAuth) {
  const url = new URL(request.url);
  if (isLegacyDiscoveryPath(url.pathname)) {
    return new Response("Not Found", { status: 404, headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    } });
  }
  const origin = url.origin;
  const path = url.pathname.replace(/^\/\.well-known\//, "");
  if (path === "http-message-signatures-directory") return botAuth(request);
  if (path === "health") return cachedJson({ status: "ok", timestamp: new Date().toISOString() }, { cacheControl: "no-store" });
  if (path === "api-catalog") return apiCatalog(origin);
  if (path === "ai-catalog.json") return aiCatalog(origin);
  if (path === "agent-skills/index.json") return agentSkillsIndex(origin);
  if (path === "agent-skills/get_site_info/SKILL.md") return siteInfoSkill(origin);
  if (path === "agent-card.json") return agentCard(origin);
  return null;
}
