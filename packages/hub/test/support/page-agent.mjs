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

/** Makes a user an ordinary Space member with this access to one page, as a Space admin would. */
export async function grantPageAccess(inTestTransaction, { spaceId, pageId, userId, access }) {
  await inTestTransaction(async (tx) => {
    await tx.query({ text: "UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id=$2",
      values: [spaceId, userId] });
    await tx.query({ text: `INSERT INTO data.page_access (space_id,page_id,subject_kind,subject_id,access,created_at)
      VALUES ($1,$2,'user',$3,$4,now()) ON CONFLICT (space_id,page_id,subject_kind,subject_id) DO UPDATE SET access=$4`,
      values: [spaceId, pageId, userId, access] });
  });
}
