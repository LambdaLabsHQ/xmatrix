const assert = require("node:assert/strict");
const test = require("node:test");

let dockBadgeText;
let planNotification;

test.before(async () => {
  const loaded = await import("./notifications.ts");
  dockBadgeText = loaded.dockBadgeText;
  planNotification = loaded.planNotification;
});

test("dockBadgeText shows the mention count when there are mentions", () => {
  assert.equal(dockBadgeText({ mentionCount: 3, hasUnread: true }), "3");
  assert.equal(dockBadgeText({ mentionCount: 1, hasUnread: false }), "1");
});

test("dockBadgeText caps the mention count at 99+", () => {
  assert.equal(dockBadgeText({ mentionCount: 100, hasUnread: true }), "99+");
  assert.equal(dockBadgeText({ mentionCount: 99, hasUnread: true }), "99");
});

test("dockBadgeText shows a dot for unread activity without mentions", () => {
  assert.equal(dockBadgeText({ mentionCount: 0, hasUnread: true }), "•");
});

test("dockBadgeText is empty when everything is read", () => {
  assert.equal(dockBadgeText({ mentionCount: 0, hasUnread: false }), "");
});

test("dockBadgeText tolerates non-finite/negative mention counts", () => {
  assert.equal(dockBadgeText({ mentionCount: Number.NaN, hasUnread: true }), "•");
  assert.equal(dockBadgeText({ mentionCount: -5, hasUnread: false }), "");
});

test("planNotification builds a Slack-style channel toast with inline reply on macOS", () => {
  const plan = planNotification(
    { title: "general", body: "Yiming Hu: ping", channelId: "c-1" },
    "darwin"
  );
  assert.equal(plan.show, true);
  assert.equal(plan.canReply, true);
  assert.equal(plan.channelId, "c-1");
  assert.equal(plan.options.title, "general");
  assert.equal(plan.options.body, "Yiming Hu: ping");
  assert.equal(plan.options.hasReply, true);
  assert.equal(plan.options.replyPlaceholder, "Reply");
});

test("planNotification highlights daemon request broker approvals", () => {
  const plan = planNotification(
    brokerNotification({ argv: ["git", "push", "origin", "main"] }),
    "darwin"
  );
  assert.equal(plan.show, true);
  assert.equal(plan.options.title, "Privileged command needs approval");
  assert.equal(plan.options.body, "codex requested: git push origin main");
  assert.equal(plan.canReply, false);
  assert.equal(plan.options.hasReply, false);
});

test("planNotification highlights secret_add requests without a command", () => {
  const plan = planNotification(
    brokerNotification({ kind: "secret_add", argv: [],
      secretAdd: { secretRef: "api-dev-key", envName: "MODEL_API_KEY", riskLevel: "high" } }),
    "darwin"
  );
  assert.equal(plan.show, true);
  assert.equal(plan.options.title, "Secret request needs approval");
  assert.equal(plan.options.body, "codex asks to add secret api-dev-key as MODEL_API_KEY");
  assert.equal(plan.canReply, false);
});

test("planNotification disables inline reply without a channel id", () => {
  const plan = planNotification({ title: "xMatrix update is ready" }, "darwin");
  assert.equal(plan.canReply, false);
  assert.equal(plan.options.hasReply, false);
  assert.equal(plan.options.replyPlaceholder, undefined);
});

test("planNotification disables inline reply off macOS", () => {
  const plan = planNotification({ title: "general", channelId: "c-1" }, "win32");
  assert.equal(plan.canReply, false);
  assert.equal(plan.options.hasReply, false);
});

test("planNotification will not show without a title", () => {
  const plan = planNotification({ body: "no title", channelId: "c-1" }, "darwin");
  assert.equal(plan.show, false);
});

function brokerNotification(request) {
  return {
    title: "general", body: "raw body", channelId: "c-1",
    metadata: { requestBroker: { phase: "pending", agentName: "codex", ...request } },
  };
}
