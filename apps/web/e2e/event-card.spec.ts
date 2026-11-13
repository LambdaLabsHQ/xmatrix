import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, openGeneralChannelWithHistory } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const STRIPE = { identityId: "app:stripe", kind: "app", label: "Stripe", name: "Stripe", userId: "", email: "",
  avatarUrl: "/app-connectors/stripe.svg" };
const same = (value: string) => ({ en: value, zh: value });
const link = (path: string) => ({ url: `https://dashboard.stripe.com/acct_1SbH3vRMzTj9NjJj/${path}`,
  label: { en: "Open in Stripe", zh: "在 Stripe 中查看" } });
const CARDS = [
  { tone: "good", title: { en: "Payment succeeded", zh: "付款成功" }, value: "10.00 USD",
    meta: [same("acct_…NjJj")], link: link("payments/pi_3UaIQSRMzTj9NjJj1OcxIw0Z") },
  { tone: "bad", title: { en: "Payment failed", zh: "付款失败" }, value: "20.00 USD", note: same("Your card was declined."),
    meta: [{ en: "Requires payment method", zh: "需要付款方式" }, same("acct_…NjJj")],
    link: link("payments/pi_3UafOfRMzTj9NjJj1umQQqnb") },
  { tone: "plain", title: { en: "Subscription canceled", zh: "订阅已取消" }, note: { en: "Cancellation requested", zh: "客户取消" },
    meta: [same("acct_…NjJj")], link: link("subscriptions/sub_1UInYbK7V6cbESKBrpGNxIDr") },
];

async function openEvents(page: Parameters<typeof openGeneralChannelWithHistory>[0]) {
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 3, lastMessageSequence: 3,
    historyHeadSequence: 3, updatedAt: E2E_NOW }, CARDS.map((card, index) => ({
    messageId: `stripe-${index}`, channelId: E2E_CHANNEL.id, sequence: index + 1, sentAt: E2E_NOW, from: STRIPE,
    body: `**${card.title.en}** — raw body for Agents`, metadata: { xmatrixEventCard: card },
  })));
  const cards = page.getByTestId("event-card");
  await expect(cards).toHaveCount(3, { timeout: 20_000 });
  return cards;
}

// An App event is a card: what happened and its amount first, then why, then where to look.
test("a Stripe event is drawn as a card, not as its text", async ({ page }) => {
  const cards = await openEvents(page);
  await expect(cards.nth(0)).toContainText("Payment succeeded");
  await expect(cards.nth(0)).toContainText("10.00 USD");
  await expect(cards.nth(1)).toContainText("Your card was declined.");
  await expect(cards.nth(1)).toContainText("Requires payment method");
  await expect(cards.nth(1)).toHaveAttribute("data-event-card", "bad");
  await expect(cards.nth(2).getByRole("link", { name: "Open in Stripe" })).toHaveAttribute("href",
    "https://dashboard.stripe.com/acct_1SbH3vRMzTj9NjJj/subscriptions/sub_1UInYbK7V6cbESKBrpGNxIDr");
  await expect(page.locator('[id="message:stripe-0"]')).not.toContainText("raw body for Agents");
  await page.screenshot({ path: test.info().outputPath("event-cards-en.png") });
});

test.describe("in Chinese", () => {
  test.use({ locale: "zh-CN" });
  test("the card reads in the reader's language", async ({ page }) => {
    const cards = await openEvents(page);
    await expect(cards.nth(0)).toContainText("付款成功");
    await expect(cards.nth(1)).toContainText("需要付款方式");
    await expect(cards.nth(2)).toContainText("客户取消");
    await expect(cards.nth(2).getByRole("link", { name: "在 Stripe 中查看" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("event-cards-zh.png") });
  });
});
