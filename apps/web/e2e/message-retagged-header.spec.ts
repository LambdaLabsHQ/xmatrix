import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* A message from the same Instance moments later keeps its header when a tag
   changed, and that header carries only the changed tag, old → new (user
   2026-10-09: 签变了能否有个更好的 UX 提示 / 搞个箭头那种，其他的签没必要显示). */

test.use({ ...E2E_DESKTOP_CONTEXT, ...(process.env.RETAG_SHOT ? { deviceScaleFactor: 2 } : {}) });

function from(gitBranch: string) {
  return {
    identityId: "agent:claude", kind: "agent", label: "claude:1", userId: "agent-owner", email: "claude@xmatrix.test",
    agentName: "claude", instanceId: "instance-claude-1", channelInstanceId: "1", instanceLabel: "claude:1",
    ownerLabel: "Yiming Hu", gitBranch, model: "claude-opus-5-5", effort: "medium",
    statusChips: [{ id: "model", label: "Model", value: "claude-opus-5-5" }],
  };
}

test("a header back within one turn shows only the changed tag, old → new", async ({ page }) => {
  const at = (minute: number) => new Date(Date.parse(E2E_NOW) + minute * 60_000).toISOString();
  const messages = [
    { body: "合并是我在 F 那版里为了缩短一行自作主张加的，不对。", sentAt: at(0), from: from("paper-label-tags") },
    { body: "effort 拆回单独的签了，CI 正在跑，绿了就合并发版。", sentAt: at(1), from: from("split-effort-tag") },
    { body: "CI 绿了，已合并。", sentAt: at(2), from: from("split-effort-tag") },
  ].map((message, index) => ({ ...message, messageId: `m-${index + 1}`, channelId: E2E_CHANNEL.id, sequence: index + 1 }));
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL, messageCount: messages.length, lastMessageSequence: messages.length, updatedAt: E2E_NOW,
  }, messages);

  const first = page.locator(".app-message-row").filter({ hasText: "自作主张" });
  const second = page.locator(".app-message-row").filter({ hasText: "拆回单独" });
  const third = page.locator(".app-message-row").filter({ hasText: "已合并" });
  await expect(first.locator(".app-message-branch-badge")).toHaveText("paper-label-tags");
  await expect(first.locator("[data-status-chip='model']")).toHaveCount(1);
  const retag = second.locator(".app-message-retag");
  await expect(retag).toHaveCount(1);
  await expect(retag.locator(".app-message-retag-from .app-message-branch-badge")).toHaveText("paper-label-tags");
  await expect(retag.locator("> .app-message-branch-badge")).toHaveText("split-effort-tag");
  await expect(second.locator("[data-status-chip]")).toHaveCount(0);
  await expect(third.locator(".app-message-continuation-gutter")).toHaveCount(1);
  if (process.env.RETAG_SHOT) {
    const top = (await first.boundingBox())!;
    const bottom = (await third.boundingBox())!;
    await page.screenshot({ path: process.env.RETAG_SHOT,
      clip: { x: top.x, y: top.y - 8, width: top.width, height: bottom.y + bottom.height - top.y + 16 } });
  }
});
