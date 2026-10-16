import { dispatchRegistrationInput } from "./registration-launch-dispatch";
import type { Env } from "./types";
import { ControlError } from "@xmatrix/db";
import { createChannel } from "./spaces";

/**
 * Opens a conversation the Hub starts on someone's behalf (an import, a pull
 * request's review) as that person, or finds it already open.
 */
export async function openConversation(env: Env, input: {
  spaceId: string; channelId: string; name: string; mode: "open" | "closed";
  metadata: Record<string, unknown>; userId: string;
}): Promise<void> {
  try {
    await createChannel(env, {
      commandId: `conversation:${input.channelId}`, channelId: input.channelId, spaceId: input.spaceId,
      name: input.name.slice(0, 80), mode: input.mode, metadata: input.metadata,
      principal: { kind: "user", id: input.userId },
    });
  } catch (error) {
    // Already open: a retry of the same conversation finds it.
    if (!(error instanceof ControlError) || error.status !== 409) throw error;
  }
}

/** Launch the registration chooser in an existing Hub-authored conversation as its author. */
export async function launchConversationAgent(env: Env, actorUserId: string,
  launch: Omit<Parameters<typeof dispatchRegistrationInput>[0], "env" | "actorUserId">): Promise<void> {
  await dispatchRegistrationInput({ env, actorUserId, ...launch });
}
