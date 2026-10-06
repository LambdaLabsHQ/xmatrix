import type { Page } from "@playwright/test";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, fixtureConversationCreate, installWorkspaceStubs, startNewConversation } from "./workspace-fixtures";
import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies, fixtureRequests, fixtureRule } from "./in-page-api-fixtures";

const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function openNewConversation(page: Page, mode: "open" | "closed") {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureConversationCreate(page, { ...E2E_CHANNEL, id: "c-img", name: "look at this", mode });
  await fixtureRule(page, { id: "upload-intents", pattern: "**/relay-v2/private-r2/upload-intents", method: "POST", responder: { kind: "relayV2UploadIntent" } });
  await fixtureJson(page, "blob-refs", "**/relay-v2/private-r2/blob-refs", { ok: true }, { method: "POST" });
  await fixtureJson(page, "upload-bytes", "**/relay-v2/private-r2/uploads/**", { ok: true }, { method: "PUT" });

  const composer = await startNewConversation(page);
  await composer.getByLabel("What should happen").fill("look at this");
  if (mode === "closed") await composer.getByTitle("Open: everyone in the Space can see it").click();
  return composer;
}

test.use(E2E_DESKTOP_CONTEXT);

for (const mode of ["open", "closed"] as const) {
  test(`a ${mode} new conversation's image uploads as it is attached, and the message sets who sees it`, async ({ page }) => {
    const composer = await openNewConversation(page, mode);
    await composer.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(imageData, "base64") });
    // The upload only makes the file exist in the Space; no conversation is made for it.
    await expect.poll(() => fixtureRequests(page, "upload-bytes"))
      .toEqual([expect.stringMatching(/\/scope\/space%3Aspace-personal$/u)]);
    expect(await fixtureRequests(page, "conversation-create")).toEqual([]);

    await composer.getByRole("button", { name: "Open shot.png" }).click();
    const dialog = page.getByRole("dialog", { name: "shot.png" });
    await expect(dialog.getByRole("img", { name: "shot.png" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close attachment" }).click();
    await expect(dialog).toHaveCount(0);

    await composer.getByLabel("What should happen").press("Enter");
    await expect(composer).toBeHidden();
    await expect.poll(() => fixtureRequestBodies(page, "conversation-first-message"))
      .toEqual([expect.objectContaining({ body: "look at this", attachments: [expect.objectContaining({ mimeType: "image/png" })] })]);
    // Visibility is the reference's: the Channel's scope, open or closed.
    expect(await fixtureRequestBodies(page, "blob-refs")).toEqual([expect.objectContaining({
      ownerKind: "message_attachment",
      visibilityScopeId: mode === "closed" ? "channel:c-img" : "space:space-personal",
    })]);
    expect(await fixtureRequests(page, "upload-bytes")).toHaveLength(1);
  });
}
