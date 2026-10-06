import { launchMentionedCodexRun, MOCK_TOKEN, startMockUserHubWorker } from "../agent-launch-postgres.fixture.mjs";

/** Exercise page commands with a real launched Agent Run, and close both sockets on every path. */
export async function withPageAgentRun(user, launch, body) {
  const worker = await startMockUserHubWorker(user);
  let run;
  try {
    run = await launchMentionedCodexRun(worker, { ownerUserId: user.id, ...launch });
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const asRun = { Authorization: `Bearer ${run.runToken}`, "content-type": "application/json" };
    return await body({ ...run, worker, auth, asRun, pages: `/api/spaces/${encodeURIComponent(run.spaceId)}/pages` });
  } finally {
    run?.agent?.ws?.close();
    run?.daemon?.ws?.close();
    await worker.stop();
  }
}
