#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseWranglerJsonValue } from "./wrangler-d1-readback.mjs";

function isSecretList(value) {
  return Array.isArray(value) && value.every((entry) => (
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof entry.name === "string" &&
    entry.name.length > 0
  ));
}

export function secretNamesFromWrangler(raw) {
  const payload = parseWranglerJsonValue(raw, isSecretList);
  return [...new Set(payload.map((entry) => entry.name))].sort();
}

export function assertSecretPolicy(names, { required = [], forbiddenPrefixes = [] } = {}) {
  const present = new Set(names);
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`required Worker secrets are missing: ${missing.join(", ")}`);
  }
  const forbidden = names.filter((name) => (
    forbiddenPrefixes.some((prefix) => name.startsWith(prefix))
  ));
  if (forbidden.length > 0) {
    throw new Error(`forbidden Worker secrets are configured: ${forbidden.join(", ")}`);
  }
  return names;
}

const TEST_HUB_REQUIRED = [
  "BETTER_AUTH_SECRET",
  "RELAY_R2_CAPABILITY_HMAC_SECRET",
  "XMATRIX_MOCK_AUTH_TOKEN",
];

const POLICIES = {
  "test-hub-email-only": {
    required: TEST_HUB_REQUIRED,
    forbiddenPrefixes: ["GOOGLE_CLIENT_"],
  },
  "test-hub-google": {
    required: [...TEST_HUB_REQUIRED, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  },
  "next-hub": {
    required: TEST_HUB_REQUIRED,
    forbiddenPrefixes: ["GOOGLE_CLIENT_"],
  },
  web: { required: ["GITHUB_TOKEN"] },
  "production-hub": {
    required: ["XMATRIX_SECRET_CATALOG_KEY"],
    forbiddenPrefixes: ["XMATRIX_MOCK_AUTH"],
  },
  "production-hub-billing": {
    required: [
      "XMATRIX_SECRET_CATALOG_KEY",
      "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRO_MONTHLY_PRICE_ID", "STRIPE_PRO_ANNUAL_PRICE_ID",
    ],
    forbiddenPrefixes: ["XMATRIX_MOCK_AUTH"],
  },
};

const [file, ...args] = process.argv.slice(2);
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const match = args.length === 1 ? /^--policy=(.+)$/u.exec(args[0]) : null;
    const options = match ? POLICIES[match[1]] : undefined;
    if (!options) {
      throw new Error(
        "Usage: wrangler-secret-policy.mjs <json-file> " +
        "--policy=<test-hub-email-only|test-hub-google|next-hub|web|production-hub|production-hub-billing>",
      );
    }
    const names = secretNamesFromWrangler(readFileSync(file, "utf8"));
    assertSecretPolicy(names, options);
    console.log(`Worker secret names verified: ${names.join(", ") || "(none)"}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
