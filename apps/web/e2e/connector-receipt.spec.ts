import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, openGeneralChannelWithHistory } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const GSC = { identityId: "app:googlesearchconsole", kind: "app", label: "Google Search Console",
  name: "Google Search Console", userId: "", email: "", avatarUrl: "/app-connectors/googlesearchconsole.svg" };
const COMMAND = "@googlesearchconsole:inspect_url:sc-domain:example.com https://example.com/pricing";
const receipt = (sequence: number, line: string) => ({
  messageId: `receipt-${sequence}`, channelId: E2E_CHANNEL.id, sequence, sentAt: E2E_NOW, from: GSC,
  body: `App connector command status:\n- ${line}`, replyToMessageId: "command",
  metadata: { xmatrixProvenance: "system_fact" },
});

// A connector's answer reads as a tool call's result: what ran and how it ended, then what it returned.
test("a connector receipt is drawn as its action, outcome and result", async ({ page }) => {
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 4, lastMessageSequence: 4,
    historyHeadSequence: 4, updatedAt: E2E_NOW }, [
    { messageId: "command", channelId: E2E_CHANNEL.id, sequence: 1, body: COMMAND, sentAt: E2E_NOW,
      from: { identityId: "user:e2e-user", kind: "user", label: "E2E Tester", name: "E2E Tester", userId: "e2e-user", email: "e2e@xmatrix.test" } },
    receipt(2, "Google Search Console inspect_url: completed; Result: [hidden — private call]."),
    receipt(3, "Google Search Console inspect_url: completed; https://example.com/pricing is **indexed**; last crawled 2026-10-25."),
    receipt(4, "Google Search Console query: failed; Search Console refused the request (403)."),
  ]);
  const cards = page.getByTestId("connector-receipt");
  await expect(cards).toHaveCount(3, { timeout: 20_000 });
  await expect(cards.nth(0)).toContainText("Inspect URL");
  await expect(cards.nth(0)).toContainText("Completed");
  await expect(cards.nth(0)).toContainText("Private result: only the caller received it");
  await expect(cards.nth(0)).not.toContainText("hidden");
  await expect(cards.nth(1).locator("strong")).toHaveText("indexed");
  await expect(cards.nth(2)).toContainText("Failed");
  await expect(cards.nth(2)).toContainText("Search Console refused the request (403)");
  // The App tag already says who wrote it; the receipt's own heading and fact tag would only repeat it.
  await expect(page.locator('[id="message:receipt-2"]')).not.toContainText("App connector command status");
  await expect(page.locator('[id="message:receipt-2"]')).not.toContainText("system fact");
  await expect(page.getByText("Google Search Console: Query search performance · Failed")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("connector-receipts.png") });
});
