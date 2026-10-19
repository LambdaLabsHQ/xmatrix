import { IPHONE_USER_AGENT, recordListCorrections } from "./list-corrections";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_MOBILE_CONTEXT } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

/* Reading back up a conversation while an Agent keeps posting into it blanked
   the timeline on iPhone: the rows slid down under a band of empty paper and
   back (user 2026-10-19, a screen recording). A message arriving below the
   reader goes in at react-virtuoso's estimate and is then measured at its own
   height. While the reader scrolls up Virtuoso took any change of the list's
   height as rows above the reader resizing and made up for it, on iPhone as a
   top margin on the list. Patched (patches/react-virtuoso+4.18.11.patch) to
   make up only for rows above the first one in view. */

test.use({
  ...E2E_MOBILE_CONTEXT,
  userAgent: IPHONE_USER_AGENT,
});

const HISTORY = 40;

test("messages arriving below a reader scrolling up move nothing above them", async ({ page }) => {
  await recordListCorrections(page);
  const space = workingAgentsSpace(2, "arrivals", { focusedInstances: 2 });
  // Rows of one height, so the list's estimate is right for every row above
  // the reader and only the arrivals, much shorter, are measured off it.
  const send = await openWorkingAgentsSpace(page, space, channelHistory(HISTORY, "arrivals-message", (row) =>
    `Row ${row}.\n\n${Array.from({ length: 6 }, () => "A paragraph of an Agent's report. ".repeat(4)).join("\n\n")}`), `Row ${HISTORY}.`);
  const agent = space.agents[1]!;
  let sequence = HISTORY;
  const arrive = () => {
    sequence += 1;
    send({ type: "channel_message_received", message: {
      messageId: `arrival-${sequence}`, channelId: E2E_CHANNEL.id, sequence, body: `Arrival ${sequence}`,
      sentAt: new Date().toISOString(), reactions: [], annotations: [], attachments: [],
      from: { kind: "agent", label: agent.name, userId: "e2e-user", email: agent.email, identityId: agent.id,
        instanceId: agent.instances[0]!.id, channelInstanceId: "2", instanceLabel: agent.instances[0]!.label },
    } });
  };
  // Past the opening landing: from here on only the reader moves the timeline.
  await page.waitForTimeout(1_500);

  const scrolling = page.evaluate(async () => {
    const probe = window as unknown as { listCorrections: string[]; readerScrolling: boolean };
    const root = document.querySelector<HTMLElement>(".app-message-timeline")!;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    root.dispatchEvent(new Event("touchstart", { bubbles: true }));
    // Clear of the newest rows first, where an arrival is the reader's to follow.
    for (let step = 0; step < 20; step += 1) {
      probe.readerScrolling = true;
      root.scrollTop -= 20;
      probe.readerScrolling = false;
      await frame();
    }
    probe.listCorrections.length = 0;
    (window as unknown as { readerClear: boolean }).readerClear = true;
    for (let step = 0; step < 120; step += 1) {
      probe.readerScrolling = true;
      root.scrollTop -= 6;
      probe.readerScrolling = false;
      await frame();
    }
    return probe.listCorrections;
  });
  await page.waitForFunction(() => (window as unknown as { readerClear?: boolean }).readerClear === true);
  for (let arrival = 0; arrival < 5; arrival += 1) {
    arrive();
    await page.waitForTimeout(250);
  }
  expect(await scrolling).toEqual([]);
});
