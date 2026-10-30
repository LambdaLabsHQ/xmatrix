"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp } from "lucide-react";
import { faceOfSender, type FaceOf } from "@xmatrix/protocol";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { Face } from "./face";
import { fetchChannelHistory } from "./workspace-admin-views";
import type { TimelineItem } from "./workspace-shell-message-model";

/** Marks a timeline row with its row id, so what is on screen can be read back. */
export const TIMELINE_ROW_ID_ATTRIBUTE = "data-timeline-row-id";

type SaidByHuman = { messageId: string; sequence?: number; author: string; face: FaceOf };

/** What the timeline shows decides the way back: a person's message in view
 * needs none, one loaded above it is the target, and with none loaded the Hub
 * is asked for the last one before what is loaded. */
type HumanAbove = { row: SaidByHuman } | { beforeSequence: number } | undefined;

function saidByHuman(row: TimelineItem | undefined): row is TimelineItem & { messageId: string } {
  return Boolean(row && !row.folded && !row.isEvent && row.senderKind === "user" && row.messageId);
}

function humanAboveView(scrollRoot: HTMLElement, rows: readonly TimelineItem[],
  byId: ReadonlyMap<string, number>): HumanAbove {
  const view = scrollRoot.getBoundingClientRect();
  let topmost: { index: number; top: number } | undefined;
  for (const element of scrollRoot.querySelectorAll<HTMLElement>(`[${TIMELINE_ROW_ID_ATTRIBUTE}]`)) {
    const rect = element.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= view.top || rect.top >= view.bottom) continue;
    const index = byId.get(element.getAttribute(TIMELINE_ROW_ID_ATTRIBUTE) ?? "");
    if (index === undefined) continue;
    if (saidByHuman(rows[index])) return undefined;
    if (!topmost || rect.top < topmost.top) topmost = { index, top: rect.top };
  }
  if (!topmost) return undefined;
  for (let index = topmost.index - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (saidByHuman(row)) return { row };
  }
  const oldest = rows.find((row) => typeof row.sequence === "number" && row.sequence > 0)?.sequence;
  return oldest && oldest > 1 ? { beforeSequence: oldest } : undefined;
}

function sameAbove(previous: HumanAbove, next: HumanAbove): boolean {
  if (!previous || !next) return previous === next;
  if ("row" in previous) return "row" in next && previous.row.messageId === next.row.messageId;
  return "beforeSequence" in next && previous.beforeSequence === next.beforeSequence;
}

/** Floats over the top of the timeline and takes the reader back up to the
 * last thing a person said, which a long run of Agent replies buries
 * (user 2026-10-30). Its row is zero high, so the list keeps its offsets. */
export function HumanAboveViewJump({ scrollRoot, rows, hidden, channelId, token, hasOlderMessages, onJump }: {
  scrollRoot: HTMLElement | null;
  rows: readonly TimelineItem[];
  hidden: boolean;
  channelId?: string;
  token: string | null;
  hasOlderMessages: boolean;
  onJump: (messageId: string, sequence?: number) => void;
}) {
  const [above, setAbove] = useState<HumanAbove>();
  const byId = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  useEffect(() => {
    if (!scrollRoot || hidden) {
      setAbove(undefined);
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setAbove((previous) => {
        const next = humanAboveView(scrollRoot, rows, byId);
        return sameAbove(previous, next) ? previous : next;
      }));
    };
    update();
    scrollRoot.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(scrollRoot);
    return () => {
      cancelAnimationFrame(frame);
      scrollRoot.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [scrollRoot, rows, byId, hidden]);
  const beforeSequence = above && "beforeSequence" in above && hasOlderMessages ? above.beforeSequence : undefined;
  const earlier = useQuery({
    queryKey: ["timeline-human-above", channelId, beforeSequence],
    enabled: Boolean(token && channelId && beforeSequence),
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<SaidByHuman | null> => {
      const page = await fetchChannelHistory(token!, channelId!, { limit: 1, beforeSequence, senderKind: "user", signal });
      const message = page.messages.at(-1);
      return message ? { messageId: message.messageId, sequence: message.sequence,
        author: message.from.label, face: faceOfSender(message.from) } : null;
    },
  });
  const target = above && "row" in above ? above.row : beforeSequence ? earlier.data : undefined;
  if (!target) return null;
  return (
    <nav aria-label="Conversation" className="pointer-events-none sticky top-2 z-20 flex h-0 justify-center overflow-visible">
      <PaperPopover
        as="button"
        type="button"
        data-testid="timeline-human-above"
        aria-label={`Back to ${target.author}'s last message`}
        onClick={() => onJump(target.messageId, target.sequence)}
        // Inline: the paper's own 8px corner outranks a utility class.
        style={{ borderRadius: 9999 }}
        className="app-timeline-human-above pointer-events-auto flex h-8 items-center gap-1.5 py-1 pl-1 pr-3 text-xs font-medium animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none"
      >
        <Face of={target.face} size="xs" showKindBadge={false} glass={false} />
        <ArrowUp className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="max-w-40 truncate">{target.author}</span>
      </PaperPopover>
    </nav>
  );
}
