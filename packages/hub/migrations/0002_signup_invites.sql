-- Invite-code signup gating.
--
-- `signup_invite_code` is the operator-minted grant. `signup_invite_claim`
-- binds one code to one email; a claim holds a seat until it is consumed by
-- account creation or expires, so an abandoned signup releases the seat
-- without an operator touching anything.

CREATE TABLE IF NOT EXISTS "signup_invite_code" (
  "code" TEXT PRIMARY KEY NOT NULL,
  "note" TEXT,
  "maxUses" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" DATE,
  "revokedAt" DATE,
  "createdBy" TEXT,
  "createdAt" DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS "signup_invite_claim" (
  "email" TEXT PRIMARY KEY NOT NULL,
  "code" TEXT NOT NULL,
  "claimedAt" DATE NOT NULL,
  "expiresAt" DATE NOT NULL,
  "consumedAt" DATE,
  "userId" TEXT
);

CREATE INDEX IF NOT EXISTS "signup_invite_claim_code_idx" ON "signup_invite_claim" ("code");
