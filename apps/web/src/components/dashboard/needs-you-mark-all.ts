/** The conversation list section whose conversations wait on the reader. */
export const NEEDS_YOU_SECTION_LABEL = "Needs you";

/**
 * "Needs you" ends in one action that marks every conversation in it done,
 * each the way its own row's Done does, once the reader confirms. Other
 * sections, an empty one, or a list that cannot mark done get no action.
 */
export function markAllDoneAction(
  section: { label: string; channels: readonly { id: string }[] },
  onMarkDone: ((channelId: string) => void) | undefined,
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): { label: string; onClick: () => void } | undefined {
  if (!onMarkDone || section.label !== NEEDS_YOU_SECTION_LABEL || section.channels.length === 0) return undefined;
  return {
    label: "Mark all done",
    onClick: () => {
      const channelIds = section.channels.map((channel) => channel.id);
      const count = channelIds.length;
      if (!confirm(`Mark ${count} conversation${count === 1 ? "" : "s"} done?`)) return;
      for (const channelId of channelIds) onMarkDone(channelId);
    },
  };
}
