-- Optional two-step verification (Better Auth two-factor), for the D1 Auth
-- authority. Mirrors packages/db 0197.
ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS "twoFactor" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "secret" TEXT NOT NULL,
  "backupCodes" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "verified" INTEGER DEFAULT 1,
  "failedVerificationCount" INTEGER DEFAULT 0,
  "lockedUntil" DATE
);

CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "twoFactor" ("userId");
