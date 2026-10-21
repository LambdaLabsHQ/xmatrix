#!/usr/bin/env node
// Every beta deploys the Hub, while the stable Web keeps the build of the last
// stable that shipped it. Before a beta deploys the Hub, the client policy it
// carries has to admit that live stable Web: the same protocol version, and a
// Web version at or above the minimum. A Hub that would answer the stable Web
// with 426 never deploys.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { runCliMain } from "./cli-entrypoint.mjs";
import { compareSemver, RELEASE_TAG_PATTERN } from "./release-version-order.mjs";

const POLICY_PATH = "packages/protocol/src/client-compatibility-policy.json";

/** Why `policy` would refuse a Web at `version` that speaks `protocolVersion`; null when it admits it. */
export function stableWebRefusal(policy, { version, protocolVersion }) {
  if (policy.protocolVersion !== protocolVersion) {
    return `this Hub speaks client protocol ${policy.protocolVersion}, the stable Web ${version} speaks ${protocolVersion}`;
  }
  if (compareSemver(version, policy.minimumVersions.app) < 0) {
    return `this Hub requires Web ${policy.minimumVersions.app} or newer, the stable Web is ${version}`;
  }
  return null;
}

/** The release a deployed Web build is: the one release tag at its commit, and the protocol it was built with. */
export function webRelease(buildId, git = (args) => execFileSync("git", args, { encoding: "utf8" })) {
  if (!/^[0-9a-f]{40}$/u.test(buildId ?? "")) throw new Error(`the stable Web build id ${buildId} is not a commit`);
  const tags = git(["tag", "--points-at", buildId]).split("\n").filter((tag) => RELEASE_TAG_PATTERN.test(tag));
  if (tags.length !== 1) {
    throw new Error(`the stable Web build ${buildId} is not exactly one release tag (${tags.join(", ") || "none"})`);
  }
  const policy = JSON.parse(git(["show", `${buildId}:${POLICY_PATH}`]));
  return { version: tags[0].slice("xmatrix-v".length), protocolVersion: policy.protocolVersion };
}

async function liveBuildId(origin) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(new URL("/api/web-build", origin), { signal: AbortSignal.timeout(15_000) });
      if (response.ok) return (await response.json()).buildId;
      if (attempt === 5) throw new Error(`${origin}/api/web-build answered ${response.status}`);
    } catch (error) {
      if (attempt === 5) throw error;
    }
    await delay(attempt * 3_000);
  }
}

async function main(argv = process.argv.slice(2)) {
  const [origin] = argv;
  if (argv.length !== 1 || !/^https:\/\/[^/]+$/u.test(origin)) {
    throw new Error("usage: stable-web-compatibility.mjs <stable Web origin>");
  }
  const stable = webRelease(await liveBuildId(origin));
  const refusal = stableWebRefusal(JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")), stable);
  if (refusal) {
    throw new Error(`This Hub would refuse the live stable Web at ${origin}: ${refusal}. ` +
      "Keep accepting it until a stable ships a newer Web.");
  }
  console.log(`The stable Web ${stable.version} at ${origin} stays compatible with this Hub.`);
}

runCliMain(import.meta.url, main);
