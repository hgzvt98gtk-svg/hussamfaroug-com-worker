import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://hussamfaroug.com";
const MAX_BODY_BYTES = 1024 * 1024;

function makeResults() {
  return {
    phase1: { oauth: false, mcp: false, auth: false },
    phase2: { retry: false, rateLimit: false },
    phase3: { metrics: false },
    allEndpoints: []
  };
}

async function responseText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("response body too large");
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function verifyDeployment(origin = DEFAULT_ORIGIN, {
  fetchImpl = fetch,
  timeoutMs = 10000
} = {}) {
  const results = makeResults();
  let base;
  try {
    base = new URL(origin);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
      throw new Error("unsupported origin");
    }
  } catch {
    return { success: false, error: "Invalid origin", results };
  }

  const targetOrigin = base.origin;
  const request = (path, accept) => fetchImpl(new URL(path, targetOrigin), {
    method: "GET",
    redirect: "manual",
    headers: { accept },
    signal: AbortSignal.timeout(timeoutMs)
  });

  async function checkJson(path, accept, validate) {
    let valid = false;
    let detail;
    try {
      const response = await request(path, accept);
      const text = await responseText(response);
      if (!response.ok) {
        detail = `HTTP ${response.status}`;
      } else {
        try {
          valid = response.headers.get("Content-Type")?.split(";")[0].trim() === accept &&
           validate(JSON.parse(text));
        } catch {
          valid = false;
        }
        if (!valid) detail = "Unexpected response";
      }
    } catch (error) {
      detail = error?.name || "Request failed";
    }
    results.allEndpoints.push({
      endpoint: path,
      status: valid ? "✅" : "❌",
      ...(detail ? { detail } : {})
    });
    return valid;
  }

  const oauthDiscovery = await checkJson(
    "/.well-known/openid-configuration",
    "application/json",
    data => Boolean(data && typeof data.issuer === "string" && data.issuer)
  );
  const protectedResource = await checkJson(
    "/.well-known/oauth-protected-resource",
    "application/json",
    data => Boolean(data?.resource === targetOrigin &&
      Array.isArray(data.authorization_servers) && data.authorization_servers.includes(targetOrigin) &&
      data.resource_documentation === targetOrigin + "/auth.md")
  );
  const authorizationServer = await checkJson(
    "/.well-known/oauth-authorization-server",
    "application/json",
    data => Boolean(data?.issuer === targetOrigin &&
      data.agent_auth?.skill === targetOrigin + "/auth.md" &&
      data.agent_auth?.register_uri === targetOrigin + "/auth.md#agent-registration" &&
      ["identity_types_supported", "credential_types_supported"].every(field =>
        Array.isArray(data.agent_auth[field]) &&
        data.agent_auth[field].every(value => typeof value === "string" && value.length > 0)))
  );
  results.phase1.oauth = oauthDiscovery && protectedResource && authorizationServer;
  results.phase1.mcp = await checkJson(
    "/.well-known/mcp/server-card.json",
    "application/json",
    data => Boolean(data?.serverInfo && typeof data.serverInfo === "object")
  );

  const authPath = "/auth.md";
  let authValid = false;
  let authDetail;
  try {
    const response = await request(authPath, "text/markdown");
    const text = await responseText(response);
    authValid = response.ok &&
      response.headers.get("Content-Type")?.split(";")[0].trim() === "text/markdown" &&
      text.includes("## Agent registration") &&
      text.includes(targetOrigin + "/.well-known/oauth-protected-resource") &&
      text.includes(targetOrigin + "/.well-known/oauth-authorization-server") &&
      text.includes("OAuth") && text.includes("MCP");
    if (!authValid) authDetail = response.ok ? "Expected Auth.md registration and discovery instructions" : `HTTP ${response.status}`;
  } catch (error) {
    authDetail = error?.name || "Request failed";
  }
  results.phase1.auth = authValid;
  results.allEndpoints.push({
    endpoint: authPath,
    status: authValid ? "✅" : "❌",
    ...(authDetail ? { detail: authDetail } : {})
  });

  const rootPath = "/";
  try {
    const response = await request(rootPath, "text/html");
    const healthy = response.ok;
    results.phase2.retry = healthy;
    results.phase2.rateLimit = healthy ||
      (response.status === 429 && response.headers.has("Retry-After"));
    results.phase3.metrics = healthy;
    if (response.body) response.body.cancel().catch(() => {});
    results.allEndpoints.push({
      endpoint: `${rootPath} (retry smoke test)`,
      status: healthy ? "✅" : "❌",
      ...(!healthy ? { detail: `HTTP ${response.status}` } : {})
    });
    results.allEndpoints.push({
      endpoint: `${rootPath} (rate limit middleware smoke test)`,
      status: results.phase2.rateLimit ? "✅ (threshold not stress-tested)" : "❌",
      ...(!results.phase2.rateLimit ? { detail: `HTTP ${response.status}` } : {})
    });
    results.allEndpoints.push({
      endpoint: "Worker health (metrics logging is not publicly exposed)",
      status: healthy ? "✅" : "❌",
      ...(!healthy ? { detail: `HTTP ${response.status}` } : {})
    });
  } catch (error) {
    const detail = error?.name || "Request failed";
    results.allEndpoints.push(
      { endpoint: `${rootPath} (retry smoke test)`, status: "❌", detail },
      { endpoint: `${rootPath} (rate limit middleware smoke test)`, status: "❌", detail },
      { endpoint: "Worker health (metrics logging is not publicly exposed)", status: "❌", detail }
    );
  }

  const success = Object.values(results).filter(value => value && !Array.isArray(value))
    .every(phase => Object.values(phase).every(Boolean));
  return { success, results, allEndpoints: results.allEndpoints };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origin = process.argv[2] || DEFAULT_ORIGIN;
  const result = await verifyDeployment(origin);
  console.log("Deployment Verification Results:");
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.success ? 0 : 1;
}
