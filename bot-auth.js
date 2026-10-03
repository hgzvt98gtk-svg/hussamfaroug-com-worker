import { b64u } from "./response.js";

const encoder = new TextEncoder();
let botAuthKeyPromise = null;

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
  var startedAt = Date.now();
  var privateJwkString = null;
  if (kv) {
    privateJwkString = await kv.get("BOT_AUTH_PRIVKEY_JWK");
    if (privateJwkString === null) {
      var publicJwkString = await kv.get("BOT_AUTH_PUBKEY_JWK");
      if (publicJwkString !== null) throw new Error("bot auth public key present without private key");
    }
  }
  var kvLoadedAt = Date.now();
  var key;
  if (privateJwkString !== null) {
    key = await buildBotAuthKey(JSON.parse(privateJwkString));
  } else {
    var keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    var privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    key = await buildBotAuthKey(privateJwk);
    if (kv) {
      var publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      await kv.put("BOT_AUTH_PRIVKEY_JWK", JSON.stringify(privateJwk));
      await kv.put("BOT_AUTH_PUBKEY_JWK", JSON.stringify(publicJwk));
      var storedPrivateJwk = await kv.get("BOT_AUTH_PRIVKEY_JWK");
      if (storedPrivateJwk === null) throw new Error("bot auth private key not readable after write");
      var storedKey = JSON.parse(storedPrivateJwk);
      if (storedKey.d !== privateJwk.d) key = await buildBotAuthKey(storedKey);
    }
  }
  console.log("bot auth key loaded: kv " + (kvLoadedAt - startedAt) + "ms, crypto " + (Date.now() - kvLoadedAt) + "ms");
  return key;
}

export async function botAuth(request, env = {}) {
  var url = new URL(request.url);
  var origin = url.origin;
  var host = url.host;
  if (botAuthKeyPromise === null) {
    botAuthKeyPromise = loadBotAuthKey(env.SITE_CONFIG);
    botAuthKeyPromise.catch(function() {
      botAuthKeyPromise = null;
    });
  }
  var key;
  try {
    key = await botAuthKeyPromise;
  } catch (error) {
    console.error("bot auth key unavailable:", error && error.message);
    return new Response("Service Unavailable", { status: 503, headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Retry-After": "30"
    } });
  }
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
}
