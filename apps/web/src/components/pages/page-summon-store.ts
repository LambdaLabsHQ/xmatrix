"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { userSpaceLocalState } from "@/lib/user-space-local-state";

/**
 * An `@` this reader wrote on a page to call an Agent (page-editor.tsx). The call is a message in a conversation
 * of its own, so the `@` reads that message's invocation as a message's `@` does: Dispatching, Spawning, …,
 * Started or Failed, its steps on hover.
 */
export interface PageSummon {
  id: string;
  pageId: string;
  harness: string;
  /** Where its `@` is, as a Yjs relative position: it stays on the `@` through everyone's edits, and reloads. */
  at: unknown;
  conversationId: string | null;
  /** The message that calls the Agent, once it is stored. */
  messageId: string | null;
  /** Why the call did not go out. */
  failure: string | null;
  /** It called a live Instance by name, in its own conversation, rather than starting one. */
  instance?: boolean;
}

/** The most recent calls this device remembers; an older `@` reads as a plain mention again. */
const KEPT = 100;
const NO_SUMMONS: PageSummon[] = [];
const memory = userSpaceLocalState<PageSummon[]>("page-summons", (value) =>
  Array.isArray(value) ? value.filter((item): item is PageSummon =>
      typeof item?.id === "string" && typeof item.pageId === "string" && typeof item.harness === "string"
      && typeof item.conversationId === "string" && typeof item.messageId === "string").slice(-KEPT) : undefined);

/**
 * The calls this reader made from pages' `@`s. Those whose message was stored are this device's memory, so the
 * `@` still shows how its call went after the page is opened again; nobody else reads them.
 */
export function usePageSummons(spaceId: string | null) {
  const { user } = useAuth();
  const userId = user?.id;
  const load = () => ({ userId, spaceId, summons: memory.read({ userId, spaceId }) ?? [] });
  const [state, setState] = useState(load);
  // A scope switch must not paint or persist the previous reader's calls.
  if (state.userId !== userId || state.spaceId !== spaceId) setState(load());
  const summons = state.userId === userId && state.spaceId === spaceId ? state.summons : NO_SUMMONS;
  useEffect(() => {
    const stored = summons.filter((summon) => summon.messageId).slice(-KEPT);
    memory.write({ userId, spaceId }, stored);
  }, [summons, userId, spaceId]);
  const change = useCallback((apply: (current: PageSummon[]) => PageSummon[]) => setState((current) =>
    current.userId === userId && current.spaceId === spaceId
      ? { ...current, summons: apply(current.summons) } : current), [userId, spaceId]);
  const add = useCallback((summon: PageSummon) => change((current) => [...current, summon]), [change]);
  const update = useCallback((id: string, patch: Partial<PageSummon>) =>
    change((current) => current.map((summon) => summon.id === id ? { ...summon, ...patch } : summon)), [change]);
  return { summons, add, update };
}
