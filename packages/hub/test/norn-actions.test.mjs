import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import * as host from "../src/norn-host.ts";
import * as libraries from "../src/norn-libraries.ts";

const load = await compileCommonJsSourceModule(new URL("../src/norn-actions.ts", import.meta.url));
class AppControlError extends Error { constructor(code, status, message) { super(message); this.code = code; this.status = status; } }

// The connector tests own parsing, freezing and executing an action, and the PostgreSQL tests own the one step from
// approved to executing. This owns what the host makes of each for a program: what it answers, says and waits for.
function fixture({ staged = { status: "pending", requestId: "action-request:1" }, claim = { request: { requestId: "action-request:1" } },
  known = true } = {}) {
  const calls = [];
  const actions = load(name => ({
    "@xmatrix/db": { AppControlError },
    "./app-connectors": { getAppConnectorProvider: id => (id === "x" ? { id: "x", name: "X" } : undefined) },
    "./connectors/connector-commands": {
      actionExecutor: (providerId, actionId) => (known && providerId === "x" && actionId === "publish_video" ? { effect: "write" } : undefined),
      stageHeldAction: async (_env, input) => { calls.push(["stage", input]); return staged; },
      heldAuthorityFailure: error => (error.code === "action_request_forbidden" ? "Current access no longer permits this approval; a Space admin must review it." : undefined),
      announceActionRequests: async (_env, spaceId, channelId) => { calls.push(["announce", spaceId, channelId]); },
    },
    "./connectors/credentials": { connectorActionRequestRepository: () => ({
      claimHeld: async input => { calls.push(["claim", input]); if (claim instanceof Error) throw claim; return claim; },
      withdrawHeld: async input => { calls.push(["withdraw", input]); return ["channel", "channel"]; },
    }) },
    "./connectors/x-upload-executor-do": { enqueueXUpload: async (_env, ref) => { calls.push(["queue", ref]); } },
    "./norn-host": host, "./norn-libraries": libraries,
  })[name]);
  const input = { type: "record", fields: { account: { type: "string", value: "@acme" }, text: { type: "string", value: "Hello" },
    video: { type: "string", value: "message-1/video-1" } } };
  const request = (verb, extra = {}) => ({ id: `request:${verb}`, verb, holder: "app:x", text: "publish_video",
    action: { app: "x", name: "publish_video", input: verb === "prepare" ? input : null, prepared: verb === "prepare" ? null : "request:prepare" }, ...extra });
  const deliver = (verb, extra = {}) => actions.deliverNornAppRequest({}, { spaceId: "space", channelId: "channel", authorityUserId: "owner",
    request: request(verb), requestRef: `r${verb}`, deliveryMessageId: `norn:r${verb}:0`, ...extra });
  return { calls, actions, deliver };
}

test("a prepared action is staged as the command it stands for, held for the program's request", async () => {
  const f = fixture();
  const outcome = await f.deliver("prepare");
  assert.deepEqual(f.calls, [["stage", { channelId: "channel", actorUserId: "owner", messageId: "norn:rprepare:0", providerId: "x",
    actionId: "publish_video", action: { effect: "write" }, heldFor: "rprepare",
    statement: { target: "@acme", text: JSON.stringify({ text: "Hello", video: "message-1/video-1" }) } }]]);
  assert.deepEqual(outcome.held, { dueInMs: 30 * 24 * 60 * 60_000 }, "the host looks again when the approval can no longer be given");
  assert.match(outcome.say, /^X publish_video: awaiting approval\. .*Pending approvals; it runs when the program performs it/u);
});

test("the app's permission, a refusal and a bad input each end the prepare at once with their own reply", async () => {
  const admitted = await fixture({ staged: { status: "approved", requestId: "action-request:1" } }).deliver("prepare");
  assert.deepEqual(admitted.reply, { tag: "Answered", value: { type: "variant", name: "Prepared", args: [{ type: "string", value: "request:prepare" }] } });
  assert.match(admitted.say, /admitted by the app's Read and write permission/u);
  const blocked = await fixture({ staged: { status: "blocked", reason: "post is denied by this app permission" } }).deliver("prepare");
  assert.deepEqual(blocked.reply, { tag: "Refused", reason: "post is denied by this app permission" });
  const failed = await fixture({ staged: { status: "failed", reason: "write a nonempty post" } }).deliver("prepare");
  assert.deepEqual(failed.reply, { tag: "Broke", reason: "write a nonempty post" });
  const unknown = fixture({ known: false });
  assert.deepEqual((await unknown.deliver("prepare")).reply, { tag: "Broke", reason: "X publish_video is not an action this host runs" });
  assert.deepEqual(unknown.calls, [], "nothing is staged for an action no provider runs");
});

test("perform takes the one claim on what was approved and hands it to the durable executor", async () => {
  const f = fixture();
  const outcome = await f.deliver("perform", { preparedRef: "rprepare" });
  assert.deepEqual(f.calls, [["claim", { spaceId: "space", channelId: "channel", prepareRef: "rprepare", performRef: "rperform" }],
    ["queue", { requestId: "action-request:1", spaceId: "space", channelId: "channel" }]]);
  assert.deepEqual(outcome, { held: { dueInMs: 30 * 60_000 } });

  const twice = fixture({ claim: { refusal: "It was performed before; a prepared action is performed once" } });
  assert.deepEqual(await twice.deliver("perform", { preparedRef: "rprepare" }),
    { reply: { tag: "Refused", reason: "It was performed before; a prepared action is performed once" } });
  assert.equal(twice.calls.some(call => call[0] === "queue"), false, "what cannot be claimed is never queued");

  const lost = fixture({ claim: new AppControlError("action_request_forbidden", 403, "private") });
  assert.deepEqual((await lost.deliver("perform", { preparedRef: "rprepare" })).reply,
    { tag: "Refused", reason: "Current access no longer permits this approval; a Space admin must review it." });
  // A failure that says nothing about authority is not an answer: the delivery is tried again.
  await assert.rejects(fixture({ claim: new Error("connection reset") }).deliver("perform", { preparedRef: "rprepare" }), /connection reset/u);
  assert.deepEqual((await fixture().deliver("perform")).reply, { tag: "Broke", reason: "What was prepared is not known to this host" });
});

test("withdrawing what programs no longer ask tells each conversation's admins once", async () => {
  const f = fixture();
  await f.actions.withdrawNornAppRequests({}, { spaceId: "space", prepareRefs: ["r1", "r2"], ended: true });
  assert.deepEqual(f.calls, [["withdraw", { spaceId: "space", prepareRefs: ["r1", "r2"], approved: true }], ["announce", "space", "channel"]]);
});

// The connector's command runner is loaded by the registry's providers while they are built, so nothing it imports
// may lead back to the registry: a provider would then be built from a module that has not run yet. Each of these
// is where a Worker, a Durable Object or a test starts loading from.
test("the Norn host and the connectors load in any order", () => {
  for (const entry of ["connectors/connector-commands.ts", "connectors/x-upload-executor-do.ts", "connectors/registry.ts",
    "connectors/platform-providers.ts", "norn-actions.ts", "norn-programs.ts", "index-routes-connector-approvals.ts"]) {
    const loaded = spawnSync(process.execPath, ["--import", "tsx", "--import", "./test/support/platform-preload.mjs", "--input-type=module",
      "-e", `await import(${JSON.stringify(new URL(`../src/${entry}`, import.meta.url).href)});`],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
    assert.equal(loaded.status, 0, `${entry} does not load by itself:\n${loaded.stderr.split("\n").slice(0, 6).join("\n")}`);
  }
});
