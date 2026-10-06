import { fakeGitHubApi } from "../github-api.fixture.mjs";
import { githubInstallationCatalog } from "../registration-launch.fixture.mjs";
import { createHmac } from "node:crypto";
import { startMockUserHubWorker, MOCK_TOKEN, homeSpaceId, json, randomUUID, registerCodexOnFreshMachine } from "../agent-launch-postgres.fixture.mjs";
import { githubAppPrivateKey } from "./github-app.mjs";

/** A PostgreSQL product worker pointing its real GitHub connector at the scenario's fake API. */
export function startGitHubUserWorker(user, apiUrl, webhookSecret) {
  return githubAppPrivateKey().then(privateKey => startMockUserHubWorker({ ...user,
    vars: { GITHUB_API_BASE_URL: apiUrl, GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: privateKey,
      ...(webhookSecret ? { GITHUB_WEBHOOK_SECRET: webhookSecret } : {}) } }));
}

/** Register the page's Agent in its Human's home Space, beside a home Channel. */
export async function registeredGitHubPageAgent(worker, userId, auth, { slug, displayName }) {
  const unique = randomUUID();
  const spaceId = await homeSpaceId(worker, auth.Authorization.replace(/^Bearer /u, ""));
  const home = (await json(await worker.fetch("/api/channels", { method: "POST", headers: auth,
    body: JSON.stringify({ spaceId, mode: "open", name: `home-${unique}`, access: [] }) }))).channel;
  const { daemon } = await registerCodexOnFreshMachine(worker, { ownerUserId: userId, spaceId, slug, displayName });
  return { home, spaceId, daemon };
}

/** Deliver the exact serialized event with GitHub's real HMAC authentication envelope. */
export function deliverGitHubWebhook(worker, { body, event, deliveryId, secret }) {
  return worker.fetch("/api/apps/github/webhook", { method: "POST", body, headers: {
    "content-type": "application/json", "x-github-event": event, "x-github-delivery": deliveryId,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } });
}

/** The same private repository offered by the real installation catalog in launch-fencing scenarios. */
export function xmatrixRepositoryInstallation(installationId) {
  return githubInstallationCatalog(installationId, [{
    id: 1, name: "xmatrix", full_name: "LambdaLabsHQ/xmatrix", private: true, archived: false,
    pushed_at: "2026-09-01T00:00:00Z", owner: { login: "LambdaLabsHQ" },
  }]);
}

/** Own both real product Worker and fake provider server throughout a GitHub scenario. */
export async function withGitHubUserScenario(user, api, secret, body) {
  const github = await fakeGitHubApi(api);
  let worker;
  try {
    worker = await startGitHubUserWorker(user, github.url, secret);
    const auth = { Authorization: `Bearer ${user.token ?? MOCK_TOKEN}`, "content-type": "application/json" };
    return await body({ worker, github, auth });
  } finally {
    if (worker) await worker.stop();
    await github.close();
  }
}
