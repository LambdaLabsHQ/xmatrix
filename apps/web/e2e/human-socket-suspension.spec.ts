import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_SPACE, E2E_USER_SENDER, E2E_MOBILE_CONTEXT,
  installWorkspaceStubs, fixtureJson, routeHumanSocket,
} from "./workspace-fixtures";

/* An iOS WebView resumes with its Human socket still OPEN but dead, and no
   close event, pong or visibility change says so. The iOS app tells the page
   it resumed, and the page replaces the socket at once instead of waiting
   out the heartbeat. */

test.use(E2E_MOBILE_CONTEXT);

const message = (sequence: number) => ({
  messageId: `frozen-${sequence}`, channelId: E2E_CHANNEL.id, sequence,
  from: E2E_USER_SENDER, body: `Frozen message ${sequence}`,
  sentAt: `2026-07-01T00:00:0${sequence}.000Z`,
  reactions: [], annotations: [], attachments: [],
});

test("the native resume signal replaces a dead Human socket at once", async ({ page }) => {
  // The first socket is the one the OS dropped: it hears nothing after
  // connecting and never answers a ping.
  const socket = await routeHumanSocket(page, (frame, reply, connection) => {
    if (frame.type === "user_focus_channel" && frame.channelId === E2E_CHANNEL.id) {
      const messages = connection === 1 ? [message(1)] : [message(1), message(2)];
      reply({ type: "channel_history", channelId: frame.channelId,
        requestId: frame.requestId, messages, hasMore: false });
    }
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "history", "**/api/xmatrix/channels/channel-general/history**",
    { messages: [message(1)], hasMore: false });
  await page.goto("/app/personal-sspaceperso/channels/general--channel-general");
  await expect(page.getByText("Frozen message 1", { exact: true })).toBeVisible();
  expect(socket.connections()).toBe(1);

  await page.evaluate(() => window.dispatchEvent(new Event("xmatrix:native-resume")));

  await expect.poll(() => socket.connections()).toBe(2);
  await expect(page.getByText("Frozen message 2", { exact: true })).toBeVisible();
});
