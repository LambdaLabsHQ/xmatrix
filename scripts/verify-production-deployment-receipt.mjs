#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { runCliMain } from "./cli-entrypoint.mjs";

export function verifyProductionDeploymentReceipt(receipt, expected) {
  const { scope, sha, tag, runId, runAttempt } = expected;
  const components = scope.split(",");
  if (!/^[0-9a-f]{40}$/u.test(sha) || !/^xmatrix-v\d+\.\d+\.\d+$/u.test(tag) ||
      !Number.isSafeInteger(runId) || runId < 1 ||
      !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new Error("Invalid expected production receipt identity");
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      receipt.schemaVersion !== 1 || receipt.scope !== scope ||
      receipt.releaseTag !== tag || receipt.version !== tag.slice("xmatrix-v".length) ||
      receipt.deploySha !== sha || receipt.runId !== runId ||
      receipt.runAttempt !== runAttempt ||
      !Array.isArray(receipt.components) ||
      receipt.components.length !== components.length ||
      receipt.components.some((item, index) => item !== components[index])) {
    throw new Error("R2 deployment receipt does not match the exact production run and scope");
  }
  if ((components.includes("hub") ? receipt.hubUrl !== "https://xmatrix-hub.xmatrix.sh" : receipt.hubUrl !== undefined) ||
      (components.includes("web") ? receipt.webUrl !== "https://xmatrix.sh" : receipt.webUrl !== undefined)) {
    throw new Error("R2 deployment receipt claims a different deployed surface");
  }
  return receipt;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error("usage: verify-production-deployment-receipt.mjs <receipt-json>");
  }
  const receipt = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  const verified = verifyProductionDeploymentReceipt(receipt, {
    scope: process.env.SOURCE_SCOPE,
    sha: process.env.SOURCE_SHA,
    tag: process.env.RELEASE_TAG,
    runId: Number(process.env.SOURCE_RUN_ID),
    runAttempt: Number(process.env.SOURCE_RUN_ATTEMPT),
  });
  console.log(`[production-receipt] verified ${verified.releaseTag} scope=${verified.scope} run=${verified.runId}:${verified.runAttempt}`);
}

runCliMain(import.meta.url, main);
