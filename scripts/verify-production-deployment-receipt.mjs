#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { runCliMain } from "./cli-entrypoint.mjs";
import { RELEASE_TAG_PATTERN, compareSemver, releaseChannel } from "./release-version-order.mjs";

const STABLE_WEB = "https://xmatrix.sh";
const BETA_WEB = "https://beta.xmatrix.sh";
// The first immutable train containing #857; beta.6 still deployed `web`.
const FIRST_BETA_WEB_VERSION = "1.3.1-beta.7";

export function verifyProductionDeploymentReceipt(receipt, expected) {
  const { scope, sha, tag, runId, runAttempt } = expected;
  const components = scope.split(",");
  if (!/^[0-9a-f]{40}$/u.test(sha) || !RELEASE_TAG_PATTERN.test(tag) ||
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
  // Historical recovery must retain its original surface, without allowing
  // later betas to claim a deployment to the stable Web.
  const webUrl = releaseChannel(receipt.version) === "beta" &&
    compareSemver(receipt.version, FIRST_BETA_WEB_VERSION) >= 0 ? BETA_WEB : STABLE_WEB;
  if ((components.includes("hub") ? receipt.hubUrl !== "https://xmatrix-hub.xmatrix.sh" : receipt.hubUrl !== undefined) ||
      (components.includes("web") ? receipt.webUrl !== webUrl : receipt.webUrl !== undefined)) {
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
