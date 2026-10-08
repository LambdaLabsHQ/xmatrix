import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import type { Env } from "./types";

/**
 * A page revision paused or resumed Automations anchored to it
 * (docs/design/pages-live-document.md §6.4); the conversations they run in
 * time them, so each coordinator is told to re-arm. The revision is already
 * committed, so a coordinator that cannot be reached is retried, then logged:
 * a pause holds regardless, because dispatch rechecks that it is enabled.
 */
export async function tellPageAutomationChannels(env: Pick<Env, "RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL">,
  channelIds: readonly string[] | undefined): Promise<void> {
  await Promise.all((channelIds ?? []).map(async (channelId) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await wakeAgentLaunchCoordinator(env, channelId, ["automation"]);
        return;
      } catch (error) {
        if (attempt >= 3) {
          console.error("page Automation coordinator did not hear of its anchor change", { channelId, error });
          return;
        }
      }
    }
  }));
}
