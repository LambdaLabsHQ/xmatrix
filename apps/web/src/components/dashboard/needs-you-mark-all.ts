import { useCallback, useEffect, useState } from "react";

/** The conversation list section whose conversations wait on the reader. */
export const NEEDS_YOU_SECTION_LABEL = "Needs you";

/** How long a first tap on Mark all done waits for the second that confirms it. */
export const MARK_ALL_CONFIRM_WINDOW_MS = 5000;

/**
 * "Needs you" ends in one action that marks every conversation in it done,
 * each the way its own row's Done does. The first tap only arms it and asks
 * "Mark N done?" in its place; a second tap confirms. The confirmation is the
 * list's own, not window.confirm: the iOS shell's web view answered that at
 * once with false and showed nothing, so the action never ran on a phone
 * (user 2026-11-09: 手机好像点不动). Other sections, an empty one, or a list
 * that cannot mark done get no action.
 */
export function markAllDoneAction(
  section: { label: string; channels: readonly { id: string }[] },
  onMarkDone: ((channelId: string) => void) | undefined,
  armed: boolean,
  setArmed: (armed: boolean) => void,
): { label: string; onClick: () => void } | undefined {
  if (!onMarkDone || section.label !== NEEDS_YOU_SECTION_LABEL || section.channels.length === 0) return undefined;
  if (!armed) return { label: "Mark all done", onClick: () => setArmed(true) };
  return {
    label: `Mark ${section.channels.length} done?`,
    onClick: () => {
      setArmed(false);
      for (const channel of section.channels) onMarkDone(channel.id);
    },
  };
}

/** Whether Mark all done waits for its confirming tap; it stops waiting on its own. */
export function useMarkAllDoneArmed(): [boolean, (armed: boolean) => void] {
  const [armed, setArmedState] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmedState(false), MARK_ALL_CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const setArmed = useCallback((next: boolean) => setArmedState(next), []);
  return [armed, setArmed];
}
