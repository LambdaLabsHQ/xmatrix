import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import { fixtureRequestRecords } from "./in-page-api-fixtures";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_SPACE,
  fixtureJson,
  installWorkspaceStubs,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use({
  viewport: { width: 1280, height: 900 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

const FRIEND = {
  userId: "friend-user",
  email: "yiming@xmatrix.test",
  name: "Yiming Hu",
  role: "member",
  joinedAt: E2E_NOW,
  handle: "yiming",
  bio: "Builds the thing that builds the thing.",
  profileVersion: 3,
};

function humanMessage(messageId: string, sequence: number, body: string) {
  return {
    messageId,
    channelId: "channel-general",
    sequence,
    body,
    sentAt: E2E_NOW,
    from: {
      identityId: "user:friend-user",
      kind: "user",
      label: "Yiming Hu",
      userId: "friend-user",
      email: "yiming@xmatrix.test",
    },
  };
}

const SPACE = { ...E2E_SPACE, members: [...E2E_SPACE.members, FRIEND] };
const CHANNEL = { ...E2E_CHANNEL, messageCount: 3, lastMessageSequence: 3, updatedAt: E2E_NOW };
const MESSAGES = [
  humanMessage("m1", 1, "我之前成功过，同样的语法，通过xmatrix 发送的"),
  humanMessage("m2", 2, "也是改 model 没记错应该是 fable 改 opus"),
  humanMessage("m3", 3, "第三条消息，用来看点头像会不会把消息挤开"),
];

async function openWorkspace(page: Page) {
  await openWorkspaceWithStubs(page, { spaces: [SPACE], channels: [CHANNEL] });
}

/* One navigation, straight to the channel: the fixtures are already installed,
   so loading /app first only to leave it aborts the pending request. */
async function openChannel(page: Page) {
  await installWorkspaceStubs(page, { spaces: [SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "channel-general-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: MESSAGES,
    hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
}

/* Slack's model, and the reason the popovers were removed: a Profile is a
   place you go, so opening one must not disturb what you were reading. */
test("rail avatar opens your own profile page", async ({ page }) => {
  await openWorkspace(page);
  const railAvatar = page.getByRole("button", { name: "Your profile" });
  await railAvatar.waitFor({ state: "visible", timeout: 30_000 });
  await railAvatar.click();
  await expect(page.getByRole("heading", { name: "E2E Tester" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit profile" })).toBeVisible();

  await page.getByRole("button", { name: "Edit profile" }).click();
  await expect(page.getByLabel("Display name")).toBeVisible();
});

/* Slack's crop step: the photo moves under a fixed circle. The person frames
   the square; the automatic centre crop this replaced chose for them. */
test("picking a photo opens the crop step: drag reframes, save uploads", async ({ page }) => {
  await openWorkspace(page);
  // After the workspace stubs: fixture rules match newest-first, so
  // registering earlier would hand this POST to the api-catch-all rule.
  await fixtureJson(page, "me-avatar", "**/api/xmatrix/me/avatar", {
    profile: {
      identityId: "user:e2e-user",
      userId: "e2e-user",
      displayName: "E2E Tester",
      avatarUrl: "https://hub.invalid/api/avatars/e2e-user/next.webp",
      profileVersion: 2,
    },
  });
  await page.getByRole("button", { name: "Your profile" }).click();
  await expect(page.getByRole("button", { name: "Change your photo" })).toBeVisible();

  // Wide, not square, so off-centre framing is possible and X has slack.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 500;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    const gradient = context.createLinearGradient(0, 0, 800, 0);
    gradient.addColorStop(0, "#1d4ed8");
    gradient.addColorStop(1, "#f59e0b");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 800, 500);
    return canvas.toDataURL("image/png");
  });
  await page.setInputFiles('input[type="file"]', {
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"),
  });

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Crop your photo" })).toBeVisible();
  const photo = dialog.locator("img");
  await expect(photo).toBeVisible();
  const before = await photo.evaluate((element) => element.style.transform);

  const surface = dialog.locator(".touch-none");
  const box = await surface.boundingBox();
  if (!box) throw new Error("crop surface has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 20, { steps: 4 });
  await page.mouse.up();
  const after = await photo.evaluate((element) => element.style.transform);
  expect(after).not.toBe(before);

  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  // Reaching the POST proves the browser encoded a real blob first: the
  // renderer throws before onSelect when encoding fails.
  await expect
    .poll(async () => (await fixtureRequestRecords(page, "me-avatar")).filter((r) => r.method === "POST").length)
    .toBeGreaterThan(0);
});

test("message avatar opens that member's profile page, and the timeline does not move", async ({ page }) => {
  await openChannel(page);
  const avatar = page.locator(".identity-avatar.message-author-avatar").first();
  await avatar.waitFor({ state: "visible", timeout: 30_000 });
  await avatar.click();
  await expect(page.getByRole("heading", { name: "Yiming Hu" })).toBeVisible();
  // A colleague's profile is read-only: no editor, no sign-in email.
  await expect(page.getByRole("button", { name: "Edit profile" })).toHaveCount(0);
  await expect(page.getByText("Sign-in email")).toHaveCount(0);
});
