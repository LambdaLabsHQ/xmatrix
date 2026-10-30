import { expect, test, type Page } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  channelHistoryFixture,
  openGeneralChannelWithPagedHistory,
} from "./workspace-fixtures";

/* A person asks once and an Agent answers at length: the question scrolls out
   of view, and a pill over the timeline takes the reader back to it
   (user 2026-10-30). */
const AGENT_SENDER = {
  identityId: "agent:claude",
  kind: "agent",
  label: "claude",
  userId: "e2e-user",
  email: "claude@xmatrix.test",
  agentName: "claude",
};
const QUESTION = "What changed in the release?";

/** A person's question at sequence 4, then the Agent's replies up to `count`. */
function history(count: number) {
  return channelHistoryFixture(count, "human-above").map((message, index) => index === 3
    ? { ...message, body: QUESTION }
    : index > 3 ? { ...message, from: AGENT_SENDER, body: `Step ${index}.\n\n${"An Agent reply line. ".repeat(60)}` }
    : message);
}

const pill = (page: Page) => page.getByTestId("timeline-human-above");
const question = (page: Page) => page.locator("#message\\:human-above-4");

for (const [name, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["phone", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(name, () => {
    test.use(context);

    // 24: the first page holds only the newest ten rows, all the Agent's, and
    // the question is found by asking the Hub for the last message a person
    // sent. 10: the question is loaded, just scrolled out of view.
    for (const count of [24, 10]) test(`the pill takes the reader back to the last thing a person said (${count})`, async ({ page }) => {
      await openGeneralChannelWithPagedHistory(page, history(count));
      await expect(page.locator(".app-message-timeline").getByText(`Step ${count - 1}.`)).toBeVisible();
      await expect(question(page)).not.toBeInViewport();

      await expect(pill(page)).toBeVisible();
      await expect(pill(page)).toHaveAccessibleName("Back to E2E Tester's last message");
      await pill(page).click();

      await expect(question(page)).toBeInViewport();
      await expect(question(page)).toHaveClass(/message-jump-highlight/);
      // A person's message in view needs no way back to it.
      await expect(pill(page)).toHaveCount(0);
    });
  });
}
