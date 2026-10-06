#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DAY_SECONDS = 24 * 60 * 60;
const abortIncompleteMultipartRule = {
  id: "abort-incomplete-multipart-1d",
  enabled: true,
  conditions: { prefix: "" },
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: DAY_SECONDS } },
};

function expirationRule(id, prefix, days) {
  return {
    id,
    enabled: true,
    conditions: { prefix },
    deleteObjectsTransition: { condition: { type: "Age", maxAge: days * DAY_SECONDS } },
  };
}

function retentionLockRule(id, prefix, days) {
  return {
    id,
    enabled: true,
    prefix,
    condition: { type: "Age", maxAgeSeconds: days * DAY_SECONDS },
  };
}

export const RELEASE_STORAGE = {
  "xmatrix-release-assets": {
    lifecycle: {
      rules: [
        expirationRule("expire-release-handoffs-14d", "handoffs/", 14),
        abortIncompleteMultipartRule,
      ],
    },
    lock: {
      rules: [retentionLockRule("retain-release-assets-90d", "releases/", 90)],
    },
  },
  "xmatrix-release-receipts": {
    lifecycle: {
      rules: [
        expirationRule("expire-production-receipts-90d", "production/", 90),
        abortIncompleteMultipartRule,
      ],
    },
    lock: {
      rules: [retentionLockRule("retain-production-receipts-90d", "production/", 90)],
    },
  },
};

function required(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function cloudflare(fetchImpl, accountId, token, pathname, options = {}) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    throw new Error(
      `Cloudflare ${options.method || "GET"} ${pathname} failed (${response.status}): ${JSON.stringify(body.errors || body)}`
    );
  }
  return body.result;
}

function sortedRules(configuration) {
  return [...(configuration?.rules || [])].sort((left, right) => left.id.localeCompare(right.id));
}

export async function configureReleaseStorage({ accountId, token, fetchImpl = fetch }) {
  accountId = required(accountId, "CLOUDFLARE_ACCOUNT_ID");
  token = required(token, "CLOUDFLARE_API_TOKEN");
  const listed = await cloudflare(fetchImpl, accountId, token, "/buckets?per_page=1000");
  const existing = new Set((listed.buckets || []).map((bucket) => bucket.name));

  for (const [bucket, desired] of Object.entries(RELEASE_STORAGE)) {
    if (!existing.has(bucket)) {
      await cloudflare(fetchImpl, accountId, token, "/buckets", {
        method: "POST",
        body: JSON.stringify({
          name: bucket,
          locationHint: "apac",
          storageClass: "Standard",
        }),
      });
      process.stdout.write(`Created R2 bucket ${bucket}\n`);
    }

    for (const [kind, configuration] of Object.entries(desired)) {
      const pathname = `/buckets/${encodeURIComponent(bucket)}/${kind}`;
      await cloudflare(fetchImpl, accountId, token, pathname, {
        method: "PUT",
        body: JSON.stringify(configuration),
      });
      const actual = await cloudflare(fetchImpl, accountId, token, pathname);
      assert.deepEqual(sortedRules(actual), sortedRules(configuration), `${bucket} ${kind} configuration mismatch`);
      process.stdout.write(`Verified R2 ${kind} rules for ${bucket}\n`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  configureReleaseStorage({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
