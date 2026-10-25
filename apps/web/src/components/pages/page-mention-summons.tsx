"use client";

import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { readChannelInvocations } from "@/components/dashboard/channel-invocations";
import { InvocationAccessError } from "@/components/dashboard/mention-invocation-query";
import {
  InvocationPopoverGroup, MentionInvocationChip, MentionInvocationRejectionChip, MentionSummonSent,
} from "@/components/dashboard/mention-invocation-chip";
import { widgetPortals } from "./page-widget-portals";
import type { PageSummon } from "./page-summon-store";

/** The summons the page's `@`s are drawn with, and how their records are read. */
export interface PageSummons { list: readonly PageSummon[]; token: string }

const chips = widgetPortals<{ summonId: string }>("page-summon");

/** Draws a summon's chip into the `@`'s widget, which is plain DOM the editor owns; the returned function takes it down. */
export function mountSummonChip(element: HTMLElement, summonId: string): () => void {
  return chips.mount(element, { summonId });
}

/** Every summoned `@` on the page, drawn into its widget from the page's tree, which knows the reader. */
export function PageMentionSummons({ summons }: { summons: PageSummons }) {
  const current = chips.useDrawn();
  return (
    <InvocationPopoverGroup>
      {current.map(({ element, key, summonId }) => {
        const summon = summons.list.find((item) => item.id === summonId);
        return summon ? createPortal(<SummonChip summon={summon} token={summons.token} />, element, key) : null;
      })}
    </InvocationPopoverGroup>
  );
}

function SummonChip({ summon, token }: { summon: PageSummon; token: string }) {
  const { user } = useAuth();
  const { conversationId, messageId } = summon;
  // Keyed under the conversation's invocations, so the Hub's `channel_invocations_changed` reads it again.
  const records = useQuery({
    queryKey: ["agent-launches", conversationId, `user:${user?.id ?? ""}`, "page-summon", messageId],
    enabled: Boolean(user && conversationId && messageId),
    retry: false,
    queryFn: ({ signal }) => readChannelInvocations(conversationId!, token, [messageId!], signal),
  });
  const launch = records.data?.launches[0];
  if (launch) {
    return <MentionInvocationChip label={summon.harness} launch={launch} shared={false}
      executions={records.data?.executions ?? []} unavailable={records.isError} />;
  }
  const rejection = records.data?.rejections?.[0];
  if (rejection) return <MentionInvocationRejectionChip rejection={rejection} unavailable={records.isError} />;
  const failure = summon.failure ?? (records.error instanceof InvocationAccessError
    ? "This conversation's invocations can't be read." : null);
  return <MentionSummonSent name={summon.harness} failure={failure} />;
}
