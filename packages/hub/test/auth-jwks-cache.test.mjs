import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair } from "jose";

import {
  getBetterAuthPublicKey,
} from "../src/auth-jwks-cache.ts";

async function publicJwk() {
  const { publicKey } = await generateKeyPair("ES256");
  return JSON.stringify(await exportJWK(publicKey));
}

function d1(publicKey, { failFirst = false, missingFirst = false } = {}) {
  let reads = 0;
  const database = {
    prepare(sql) {
      assert.equal(sql, 'SELECT "id", "publicKey" FROM "jwks" WHERE "id" = ?');
      return {
        bind(kid) {
          return {
            async first() {
              reads += 1;
              if (failFirst && reads === 1) throw new Error("temporary D1 failure");
              if (missingFirst && reads === 1) return null;
              return { id: kid, publicKey };
            },
          };
        },
      };
    },
  };
  return { database, env: { AUTH_DB: database }, reads: () => reads };
}

test("reuses an imported Better Auth public key within one D1 binding", async () => {
  const source = d1(await publicJwk());
  const first = await getBetterAuthPublicKey(source.env, "key-1");
  const second = await getBetterAuthPublicKey(source.env, "key-1");

  assert.ok(first);
  assert.equal(second, first);
  assert.equal(source.reads(), 1);
});

test("coalesces concurrent reads for the same Better Auth key", async () => {
  const source = d1(await publicJwk());
  const keys = await Promise.all(
    Array.from({ length: 20 }, () => getBetterAuthPublicKey(source.env, "key-2")),
  );

  assert.ok(keys[0]);
  assert.ok(keys.every((key) => key === keys[0]));
  assert.equal(source.reads(), 1);
});

test("isolates cached keys by D1 binding", async () => {
  const firstSource = d1(await publicJwk());
  const secondSource = d1(await publicJwk());
  const first = await getBetterAuthPublicKey(firstSource.env, "shared-kid");
  const second = await getBetterAuthPublicKey(secondSource.env, "shared-kid");

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
  assert.equal(firstSource.reads(), 1);
  assert.equal(secondSource.reads(), 1);
});

test("does not cache missing keys", async () => {
  const source = d1(await publicJwk(), { missingFirst: true });
  assert.equal(await getBetterAuthPublicKey(source.env, "eventual-key"), null);
  assert.ok(await getBetterAuthPublicKey(source.env, "eventual-key"));
  assert.equal(source.reads(), 2);
});

test("reports a failed key read instead of answering it as an unknown key, and retries it", async () => {
  const source = d1(await publicJwk(), { failFirst: true });
  await assert.rejects(getBetterAuthPublicKey(source.env, "eventual-key"), /temporary D1 failure/);
  assert.ok(await getBetterAuthPublicKey(source.env, "eventual-key"));
  assert.equal(source.reads(), 2);
});

test("evicts malformed public keys instead of retaining a rejected promise", async () => {
  const source = d1("not-json");
  await assert.rejects(
    getBetterAuthPublicKey(source.env, "malformed-key"),
    SyntaxError,
  );
  await assert.rejects(
    getBetterAuthPublicKey(source.env, "malformed-key"),
    SyntaxError,
  );
  assert.equal(source.reads(), 2);
});
