import { expect, test, type Page } from "./fixtures";
import { fixtureJson, fixtureRequestBodies, fixtureRule } from "./in-page-api-fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_USER_SENDER, openGeneralChannelWithHistory } from "./workspace-fixtures";
import { draftValue, expectDraft } from "./composer-draft";

test.use(E2E_DESKTOP_CONTEXT);

// Two pixels of different colours, so the rows show which picture is which.
const RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";
const png = (name: string, data: string) => ({ name, mimeType: "image/png", buffer: Buffer.from(data, "base64") });

async function openComposer(page: Page, history: Parameters<typeof openGeneralChannelWithHistory>[2] = []) {
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, history);
  await fixtureRule(page, { id: "picture-intent", pattern: "**/relay-v2/private-r2/upload-intents", method: "POST", responder: { kind: "relayV2UploadIntent" } });
  await fixtureJson(page, "picture-ref", "**/relay-v2/private-r2/blob-refs", { ok: true }, { method: "POST" });
  await fixtureJson(page, "picture-bytes", "**/relay-v2/private-r2/uploads/**", { ok: true }, { method: "PUT" });
  await fixtureJson(page, "picture-send", `**/channels/${E2E_CHANNEL.id}/messages`, {}, { method: "POST" });
  return page.locator(".composer-textarea").first();
}

/** Attaches two pictures after whatever is typed first, and the pictures the draft then shows. */
async function attachTwo(page: Page, composer: import("@playwright/test").Locator, typed = "") {
  await composer.click();
  if (typed) await page.keyboard.type(typed);
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles([png("red.png", RED), png("blue.png", BLUE)]);
  const pictures = page.getByTestId("composer-picture");
  await expect(pictures).toHaveCount(2);
  return { input, pictures };
}

// Pictures are blocks of what is written: put where the caret is, several to a row, in order among the words.
test("pictures go into the draft where the caret is, a row at a time, and send in their places", async ({ page }) => {
  const composer = await openComposer(page);
  const { input, pictures } = await attachTwo(page, composer, "Before");
  // Two pictures put together are one row.
  const [first, second] = [await pictures.nth(0).boundingBox(), await pictures.nth(1).boundingBox()];
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
  expect(second!.x).toBeGreaterThan(first!.x);
  await page.keyboard.type("Between");
  await input.setInputFiles([png("red-again.png", RED)]);
  await expect(pictures).toHaveCount(3);
  // The third, after the words, is a row of its own.
  expect((await pictures.nth(2).boundingBox())!.y).toBeGreaterThan(first!.y + 20);
  await page.keyboard.type("After");
  // None of them waits in the strip above the words.
  await expect(page.getByRole("button", { name: "Open red.png" })).toHaveCount(1);
  await expect.poll(async () => (await draftValue(composer))?.replace(/attachment:[^)]+/gu, "attachment:*"))
    .toBe("Before\n![red.png](attachment:*)\n![blue.png](attachment:*)\nBetween\n![red-again.png](attachment:*)\nAfter");
  await page.screenshot({ path: test.info().outputPath("composer-pictures.png"), clip: await around(composer) });

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => fixtureRequestBodies(page, "picture-send")).toEqual([expect.objectContaining({
    body: "Before\n\n![red.png](attachment:1)\n![blue.png](attachment:2)\n\nBetween\n\n![red-again.png](attachment:3)\n\nAfter",
    attachments: [expect.objectContaining({ name: "red.png" }), expect.objectContaining({ name: "blue.png" }),
      expect.objectContaining({ name: "red-again.png" })],
  })]);
});

// A picture's × or Backspace beside it takes it out of the draft and its file out of the message.
test("removing a picture from the draft takes its file along", async ({ page }) => {
  const composer = await openComposer(page);
  const { pictures } = await attachTwo(page, composer);
  await page.keyboard.type("Words");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(pictures).toHaveCount(1);
  await pictures.first().getByRole("button", { name: "Remove red.png" }).click();
  await expect(pictures).toHaveCount(0);
  await expectDraft(composer, "Words");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => fixtureRequestBodies(page, "picture-send")).toEqual([expect.objectContaining({ body: "Words" })]);
  const [sent] = await fixtureRequestBodies(page, "picture-send") as { attachments?: unknown[] }[];
  expect(sent!.attachments ?? []).toEqual([]);
});

// A message draws the pictures its words name where they were put, adjacent ones as one row; others stay under it.
test("a message draws its pictures where its words put them", async ({ page }) => {
  const attachment = (id: string, name: string, data: string) => ({ id, kind: "image", name, mimeType: "image/png", size: 68,
    dataUrl: `data:image/png;base64,${data}` });
  await openComposer(page, [{ messageId: "m-pictures", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: "看这两张：\n\n![red.png](attachment:1)\n![blue.png](attachment:2)\n\n还有这张\n\n![third.png](attachment:3)\n\n完",
    attachments: [attachment("a1", "red.png", RED), attachment("a2", "blue.png", BLUE), attachment("a3", "third.png", RED),
      attachment("a4", "extra.png", BLUE)] }]);
  const body = page.locator("[data-message-body='m-pictures']");
  const rows = body.locator(".message-picture-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator(".message-picture")).toHaveCount(2);
  await expect(rows.nth(1).locator(".message-picture")).toHaveCount(1);
  const order = await body.locator(".rich-message > *").evaluateAll((nodes) => nodes.map((node) =>
    node.classList.contains("message-picture-row") ? `row:${node.querySelectorAll(".message-picture").length}` : node.textContent?.trim()));
  expect(order).toEqual(["看这两张：", "row:2", "还有这张", "row:1", "完"]);
  // The attachment the words do not name stays under them.
  await expect(page.getByRole("button", { name: "Open extra.png" })).toHaveCount(1);
  await expect(body.getByRole("button", { name: "Open extra.png" })).toHaveCount(0);
  await body.locator("..").screenshot({ path: test.info().outputPath("message-pictures.png") });
});

async function around(element: import("@playwright/test").Locator) {
  const box = (await element.boundingBox())!;
  return { x: box.x - 60, y: box.y - 40, width: box.width + 140, height: box.height + 80 };
}

// Attachment fallback follows the pictures actually rendered, including Markdown
// literals, references and the disclosure/plain-text paths. The upload tests above
// cover generated picture rows; they cannot catch a second parser hiding a file.
test("literal picture syntax and quoted passages keep their attachments available", async ({ page }) => {
  const bodies = [
    "```md\n![red.png](attachment:1)\n```",
    "    ![red.png](attachment:1)",
    "> ![red.png](attachment:1)\n\n— [Elsewhere](https://xmatrix.sh/app/s/channels/c#message:m1)\n\nWords",
  ];
  await openComposer(page, bodies.map((body, index) => ({ messageId: `literal-${index}`, channelId: E2E_CHANNEL.id,
    sequence: index + 1, sentAt: E2E_NOW, from: E2E_USER_SENDER, body,
    attachments: [{ id: `literal-file-${index}`, kind: "image", name: "red.png", mimeType: "image/png", size: 68,
      dataUrl: `data:image/png;base64,${RED}` }] })));
  for (let index = 0; index < bodies.length; index += 1) {
    const row = page.locator(`[id="message:literal-${index}"]`);
    await expect(row.getByRole("button", { name: "Open red.png" })).toHaveCount(1);
    await expect(row.locator(".message-picture")).toHaveCount(0);
  }
});

test("Markdown image references consume a file once where they render", async ({ page }) => {
  await openComposer(page, [{ messageId: "reference-picture", channelId: E2E_CHANNEL.id, sequence: 1,
    sentAt: E2E_NOW, from: E2E_USER_SENDER, body: "![red.png][photo]\n\n[photo]: attachment:1",
    attachments: [{ id: "reference-file", kind: "image", name: "red.png", mimeType: "image/png", size: 68,
      dataUrl: `data:image/png;base64,${RED}` }] }]);
  const row = page.locator('[id="message:reference-picture"]');
  await expect(row.locator(".message-picture").getByRole("button", { name: "Open red.png" })).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Open red.png" })).toHaveCount(1);
});

test("a picture outside the shown text stays available through expansion and plain-text rendering", async ({ page }) => {
  await openComposer(page, [{ messageId: "long-picture", channelId: E2E_CHANNEL.id, sequence: 1,
    sentAt: E2E_NOW, from: E2E_USER_SENDER, body: `${"Long message. ".repeat(4_000)}\n\n![red.png](attachment:1)`,
    attachments: [{ id: "long-file", kind: "image", name: "red.png", mimeType: "image/png", size: 68,
      dataUrl: `data:image/png;base64,${RED}` }] }]);
  const row = page.locator('[id="message:long-picture"]');
  await expect(row.getByRole("button", { name: "Open red.png" })).toHaveCount(1);
  await row.getByRole("button", { name: "Show more" }).click();
  await expect(row.locator(".message-plain-text")).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Open red.png" })).toHaveCount(1);
});
