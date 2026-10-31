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

/** A schedule line (docs/design/pages-live-document.md §6.1): its instruction, then when it runs. */
export function scheduleLine(instruction, { intervalMinutes, at }) {
  const when = at ? `⏳ ${new Date(at).toISOString().replace(/\.\d{3}Z$/u, "Z")}` : `🔁 every ${intervalMinutes} minutes`;
  return `- [ ] ${instruction} ${when}`;
}

/**
 * A page's Automation, made the only way one is: writing its line on a page.
 * The Space gets one "Automations" page the first time; this waits until the
 * line has synced and returns its Automation.
 */
export async function createTask(worker, { spaceId, token = MOCK_TOKEN, message, expression, intervalMinutes, at,
  instruction: given }) {
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const pages = automationPages.get(worker) ?? new Map();
  automationPages.set(worker, pages);
  const instruction = expression?.text ?? message?.body ?? given;
  const line = scheduleLine(instruction, { intervalMinutes, at });
  const base = `/api/spaces/${encodeURIComponent(spaceId)}/pages`;
  if (!pages.has(spaceId)) {
    const created = await worker.fetch(base, { method: "POST", headers,
      body: JSON.stringify({ title: "Automations", body: `# Automations\n\n## Schedules\n\n${line}\n` }) });
    assert.equal(created.status, 200, await created.clone().text());
    pages.set(spaceId, (await created.json()).page.pageId);
  } else {
    const path = `${base}/${encodeURIComponent(pages.get(spaceId))}`;
    const current = (await json(await worker.fetch(path, { headers }))).page;
    const written = await worker.fetch(path, { method: "PUT", headers, body: JSON.stringify({
      baseRevision: current.headRevision, body: `${current.body.trimEnd()}\n${line}\n` }) });
    assert.equal(written.status, 200, await written.clone().text());
  }
  const deadline = Date.now() + 15_000;
  for (;;) {
    const automation = (await listTasks(worker, spaceId, token)).automations.find((item) => item.source === line);
    if (automation) return automation;
    assert.ok(Date.now() < deadline, `the schedule line did not sync: ${line}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function listTasks(worker, spaceId, token = MOCK_TOKEN) {
  const query = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : "";
  return json(await worker.fetch(`/api/automations${query}`, {
    headers: { Authorization: `Bearer ${token}` },
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
