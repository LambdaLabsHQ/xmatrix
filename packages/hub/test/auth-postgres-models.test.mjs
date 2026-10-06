import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_POSTGRES_MODELS,
} from "../src/auth-postgres-models.ts";

test("PostgreSQL Better Auth mapping covers every migrated adapter model", () => {
  assert.deepEqual(Object.keys(AUTH_POSTGRES_MODELS), [
    "user", "session", "account", "verification", "jwks",
  ]);
  assert.deepEqual(Object.values(AUTH_POSTGRES_MODELS).map(({ modelName }) => modelName), [
    "control.auth_users", "control.auth_sessions", "control.auth_accounts",
    "control.auth_verifications", "control.auth_jwks",
  ]);
  assert.ok(Object.values(AUTH_POSTGRES_MODELS).every(
    ({ modelName }) => modelName.startsWith("control."),
  ));
  assert.equal(AUTH_POSTGRES_MODELS.user.fields.emailVerified, "email_verified");
  assert.equal(AUTH_POSTGRES_MODELS.user.additionalFields.profileVersion, "profile_version");
  assert.equal(AUTH_POSTGRES_MODELS.session.fields.userId, "user_id");
  assert.equal(AUTH_POSTGRES_MODELS.account.fields.refreshTokenExpiresAt, "refresh_token_expires_at");
  assert.equal(AUTH_POSTGRES_MODELS.verification.fields.expiresAt, "expires_at");
  assert.equal(AUTH_POSTGRES_MODELS.jwks.fields.privateKey, "private_key");
});
