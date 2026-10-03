import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { botAuth } from "../bot-auth.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function privateKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}

const firstKey = await privateKey();
const secondKey = await privateKey();
const request = new Request("https://hussamfaroug.com/.well-known/http-message-signatures-directory");

function binding(value) {
  return {
    value,
    reads: 0,
    writes: 0,
    async get(name) {
      assert.equal(name, "BOT_AUTH_PRIVKEY_JWK");
      this.reads++;
      return this.value;
    },
    async put() {
      this.writes++;
      throw new Error("request-time writes are forbidden");
    }
  };
}

function captureErrors(t) {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  return errors;
}

async function assertUnavailable(response) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Retry-After"), "30");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Signature"), null);
  assert.equal(await response.text(), "Service Unavailable");
}

async function assertSigned(response, expectedKey) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/http-message-signatures-directory+json");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=240");
  assert.match(response.headers.get("Signature"), /^sig1=:[A-Za-z0-9+/]+={0,2}:$/);
  const { keys: [publicKey] } = await response.json();
  assert.equal(publicKey.x, expectedKey.x);
  assert.equal(publicKey.d, undefined);
  const thumbprint = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify({ crv: "Ed25519", kty: "OKP", x: expectedKey.x })
  ))).toString("base64url");
  assert.equal(publicKey.kid, thumbprint);
  const input = response.headers.get("Signature-Input");
  assert.ok(input.includes(`keyid="${thumbprint}"`));
  const created = Number(input.match(/created=(\d+)/)[1]);
  const expires = Number(input.match(/expires=(\d+)/)[1]);
  assert.equal(expires - created, 300);
  const base = [
    '"@authority": hussamfaroug.com',
    `"signature-agent": ${response.headers.get("Signature-Agent")}`,
    `"@signature-params": ${input.slice(input.indexOf("=") + 1)}`
  ].join("\n");
  const verificationKey = await crypto.subtle.importKey(
    "jwk", { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x },
    { name: "Ed25519" }, false, ["verify"]
  );
  const signature = Buffer.from(response.headers.get("Signature").match(/^sig1=:([^:]+):$/)[1], "base64");
  assert.equal(await crypto.subtle.verify(
    "Ed25519", verificationKey, signature, new TextEncoder().encode(base)
  ), true);
  return publicKey.kid;
}

test("missing configuration fails closed without generating or writing keys", async (t) => {
  const errors = captureErrors(t);
  t.mock.method(crypto.subtle, "generateKey", () => { throw new Error("must not generate"); });
  await assertUnavailable(await botAuth(request));
  await assertUnavailable(await botAuth(request, { SITE_CONFIG: {} }));
  for (const value of [null, undefined, ""]) {
    const kv = binding(value);
    await assertUnavailable(await botAuth(request, { SITE_CONFIG: kv }));
    assert.equal(kv.reads, 1);
    assert.equal(kv.writes, 0);
  }
  assert.equal(crypto.subtle.generateKey.mock.callCount(), 0);
  assert.ok(errors.every(args => args.length === 1 && args[0] === "bot auth unavailable"));
});

test("malformed JSON and invalid JWKs fail closed without logging key contents", async (t) => {
  const errors = captureErrors(t);
  const invalidValues = [
    '{"d":"secret-private-key", invalid',
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...firstKey, kty: "RSA" }),
    JSON.stringify({ ...firstKey, crv: "X25519" }),
    JSON.stringify({ ...firstKey, d: undefined }),
    JSON.stringify({ ...firstKey, x: 123 }),
    JSON.stringify({ ...firstKey, d: "malformed-secret" }),
    JSON.stringify({ ...firstKey, x: "invalid" })
  ];
  for (const value of invalidValues) {
    const kv = binding(value);
    await assertUnavailable(await botAuth(request, { SITE_CONFIG: kv }));
    assert.equal(kv.writes, 0);
  }
  assert.deepEqual(errors, invalidValues.map(() => ["bot auth unavailable"]));
});

test("a private key with a mismatched public component is rejected", async (t) => {
  captureErrors(t);
  const kv = binding(JSON.stringify({ ...firstKey, x: secondKey.x }));
  await assertUnavailable(await botAuth(request, { SITE_CONFIG: kv }));
  assert.equal(kv.writes, 0);
});

test("KV failures are sanitized and a later request can retry", async (t) => {
  const errors = captureErrors(t);
  const kv = binding(JSON.stringify(firstKey));
  const get = kv.get.bind(kv);
  kv.get = async () => { throw new Error(`private secret ${firstKey.d}`); };
  await assertUnavailable(await botAuth(request, { SITE_CONFIG: kv }));
  kv.get = get;
  await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), firstKey);
  assert.deepEqual(errors, [["bot auth unavailable"]]);
});

test("pre-provisioned keys produce verifiable signatures without KV writes", async () => {
  const kv = binding(JSON.stringify(firstKey));
  await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), firstKey);
  await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), firstKey);
  assert.equal(kv.reads, 1);
  assert.equal(kv.writes, 0);
});

test("concurrent requests share one in-flight KV read and key import", async (t) => {
  let release;
  const kv = binding(JSON.stringify(firstKey));
  const get = kv.get.bind(kv);
  kv.get = async name => {
    await new Promise(resolve => { release = resolve; });
    return get(name);
  };
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "importKey", (...args) => importKey(...args));
  const pending = Array.from({ length: 12 }, () => botAuth(request, { SITE_CONFIG: kv }));
  release();
  const responses = await Promise.all(pending);
  assert.equal(kv.reads, 1);
  assert.equal(crypto.subtle.importKey.mock.callCount(), 2);
  for (const response of responses) await assertSigned(response, firstKey);
  assert.equal(kv.writes, 0);
});

test("concurrent requests on different bindings never share signing keys", async () => {
  const first = binding(JSON.stringify(firstKey));
  const second = binding(JSON.stringify(secondKey));
  const responses = await Promise.all([
    botAuth(request, { SITE_CONFIG: first }),
    botAuth(request, { SITE_CONFIG: second })
  ]);
  const firstKid = await assertSigned(responses[0], firstKey);
  const secondKid = await assertSigned(responses[1], secondKey);
  assert.notEqual(firstKid, secondKid);
  assert.equal(first.reads, 1);
  assert.equal(second.reads, 1);
});

test("rotation takes effect at the 60-second cache boundary", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const kv = binding(JSON.stringify(firstKey));
  await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), firstKey);
  kv.value = JSON.stringify(secondKey);
  now += 59_999;
  await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), firstKey);
  assert.equal(kv.reads, 1);
  now++;
  const responses = await Promise.all(Array.from({ length: 8 }, () => botAuth(request, { SITE_CONFIG: kv })));
  for (const response of responses) await assertSigned(response, secondKey);
  assert.equal(kv.reads, 2);
  assert.equal(kv.writes, 0);
});

test("expired keys are not used if rotated configuration is missing or invalid", async (t) => {
  captureErrors(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  for (const value of [null, "{secret-private-key"]) {
    const kv = binding(JSON.stringify(firstKey));
    await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), firstKey);
    now += 60_000;
    kv.value = value;
    await assertUnavailable(await botAuth(request, { SITE_CONFIG: kv }));
    kv.value = JSON.stringify(secondKey);
    await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), secondKey);
    assert.equal(kv.reads, 3);
  }
});

test("cache lifetime is bounded from read start rather than load completion", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const kv = binding(JSON.stringify(firstKey));
  const get = kv.get.bind(kv);
  kv.get = async name => {
    const value = await get(name);
    now += 60_000;
    return value;
  };
  await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), firstKey);
  kv.value = JSON.stringify(secondKey);
  await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), secondKey);
  assert.equal(kv.reads, 2);
});

test("signing failures return sanitized, non-cacheable 503 responses", async (t) => {
  const errors = captureErrors(t);
  const kv = binding(JSON.stringify(firstKey));
  await assertSigned(await botAuth(request, { SITE_CONFIG: kv }), firstKey);
  t.mock.method(crypto.subtle, "sign", () => { throw new Error(`sign failed: ${firstKey.d}`); });
  await assertUnavailable(await botAuth(request, { SITE_CONFIG: kv }));
  assert.deepEqual(errors, [["bot auth unavailable"]]);
});

test("key validation signing failures also fail closed", async (t) => {
  const errors = captureErrors(t);
  t.mock.method(crypto.subtle, "sign", () => Promise.reject(new Error(`secret: ${firstKey.d}`)));
  const kv = binding(JSON.stringify(firstKey));
  await assertUnavailable(await botAuth(request, { SITE_CONFIG: kv }));
  assert.deepEqual(errors, [["bot auth unavailable"]]);
});
