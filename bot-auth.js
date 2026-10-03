import { b64u } from "./response.js";

const encoder = new TextEncoder();
const keyCacheTtl = 60_000;
const botAuthKeys = new WeakMap();

async function buildBotAuthKey(privateJwk) {
  if (!privateJwk || privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || typeof privateJwk.x !== "string" || typeof privateJwk.d !== "string") {
    throw new Error("invalid bot auth private key");
  }
  var signingKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
  var publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: privateJwk.x }, { name: "Ed25519" }, false, ["verify"]);
  var probe = encoder.encode("bot-auth-key-check");
  if (!await crypto.subtle.verify("Ed25519", publicKey, await crypto.subtle.sign("Ed25519", signingKey, probe), probe)) {
    throw new Error("bot auth private key does not match its public component");
  }
  var kid = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: privateJwk.x })))));
  var body = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid, x: privateJwk.x, alg: "EdDSA" }] });
  return { signingKey, kid, body };
}

async function loadBotAuthKey(kv) {
  var privateJwkString = await kv.get("BOT_AUTH_PRIVKEY_JWK");
  if (typeof privateJwkString !== "string" || !privateJwkString) {
    throw new Error("bot auth private key not provisioned");
  }
  return buildBotAuthKey(JSON.parse(privateJwkString));
}

async function getBotAuthKey(kv) {
  if (!kv || typeof kv.get !== "function") throw new Error("bot auth configuration unavailable");
  var entry = botAuthKeys.get(kv);
  if (entry && (entry.pending || Date.now() < entry.expiresAt)) return entry.promise;
  entry = { pending: true, expiresAt: Date.now() + keyCacheTtl };
  entry.promise = loadBotAuthKey(kv).then(function(key) {
    entry.pending = false;
    return key;
  }, function(error) {
    botAuthKeys.delete(kv);
    throw error;
  });
  botAuthKeys.set(kv, entry);
  return entry.promise;
}

function unavailable() {
  console.error("bot auth unavailable");
  return new Response("Service Unavailable", { status: 503, headers: {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Retry-After": "30"
  } });
}

export async function botAuth(request, env = {}) {
  var url = new URL(request.url);
  var origin = url.origin;
  var host = url.host;
  try {
    var key = await getBotAuthKey(env.SITE_CONFIG);
    var created = Math.floor(Date.now() / 1e3), expires = created + 300;
    var signatureInput = 'sig1=("@authority" "signature-agent");created=' + created + ';keyid="' + key.kid + '";alg="ed25519";expires=' + expires + ';tag="web-bot-auth"';
    var signatureBase = '"@authority": ' + host + '\n"signature-agent": "' + origin + '"\n"@signature-params": ' + signatureInput.slice(signatureInput.indexOf("=") + 1);
    var signature = btoa(String.fromCharCode.apply(null, new Uint8Array(await crypto.subtle.sign("Ed25519", key.signingKey, encoder.encode(signatureBase)))));
    return new Response(key.body, { headers: {
      "Content-Type": "application/http-message-signatures-directory+json",
      "Access-Control-Allow-Origin": "*",
      "Signature-Agent": '"' + origin + '"',
      "Signature-Input": signatureInput,
      "Signature": "sig1=:" + signature + ":",
      "Cache-Control": "public, max-age=240"
    } });
  } catch {
    return unavailable();
  }
}
