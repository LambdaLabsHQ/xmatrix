// Shared setup for the Automation e2e files, split so the rolling Hub test pool
// can run their independent, fixture-heavy tests in parallel.
import {
  assert,
  json,
  mintAgentRunToken,
  MOCK_TOKEN,
  randomUUID,
  startHubWorker,
  test,
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import { nextAutomationRunAt } from "../src/automation-cadence.mjs";
import { admitRegisteredSpawn, channelSpaceId, connectDaemon, createRoutableAgent, isSpawnOf,
  sendSpawnResult, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

export const authHeaders = {
  Authorization: `Bearer ${MOCK_TOKEN}`,
  "content-type": "application/json",
};

export async function createSpaceAndChannel(worker, unique, suffix = "main") {
  const space = (await json(await worker.fetch("/api/spaces", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: `Automation ${suffix} ${unique}` }),
  }))).space;
  const channel = (await json(await worker.fetch("/api/channels", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      spaceId: space.id,
      name: `automation-${suffix}-${unique}`,
    }),
  }))).channel;
  return { space, channel };
}

const automationPages = new WeakMap();

/**
 * A page's Automation, made through its page (docs/design/pages-live-document.md
 * §6): an Automation belongs to a page section and runs in a conversation of
 * its own. The Space gets one "Automations" page the first time.
 */
export async function createTask(worker, { spaceId, token = MOCK_TOKEN, message, expression, ...input }) {
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const pages = automationPages.get(worker) ?? new Map();
  automationPages.set(worker, pages);
  if (!pages.has(spaceId)) {
    const created = await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/pages`, {
      method: "POST", headers, body: JSON.stringify({ title: "Automations", body: "# Automations\n\n## Schedules\n" }) });
    assert.equal(created.status, 200, await created.clone().text());
    pages.set(spaceId, (await created.json()).page.pageId);
  }
  const instruction = expression?.text ?? message?.body ?? input.instruction;
  const response = await worker.fetch(
    `/api/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pages.get(spaceId))}/automations`, {
      method: "POST", headers, body: JSON.stringify({ blockId: "schedules", ...input, instruction }) });
  assert.equal(response.status, 201, await response.clone().text());
  return (await json(response)).automation;
}

export async function listTasks(worker, spaceId) {
  const query = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : "";
  return json(await worker.fetch(`/api/automations${query}`, {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  }));
}

export async function waitForTask(worker, taskId, predicate) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const task = (await listTasks(worker)).automations.find((candidate) => candidate.id === taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Automation ${taskId}`);
}

export async function channelHistory(worker, channelId) {
  return (await json(await worker.fetch(
    `/api/channels/${encodeURIComponent(channelId)}/history?limit=100`,
    { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
  ))).messages;
}


export {
  assert,
  json,
  mintAgentRunToken,
  MOCK_TOKEN,
  randomUUID,
  startHubWorker,
  test,
  waitForChannelHistoryMessage,
  nextAutomationRunAt,
  admitRegisteredSpawn,
  createRoutableAgent,
  channelSpaceId,
  isSpawnOf,
  connectDaemon,
  sendSpawnResult,
  startPgHubWorker,
};
