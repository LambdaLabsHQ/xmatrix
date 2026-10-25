"use client";

import { useCallback, useEffect, useState } from "react";

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
}

const STORAGE_KEY = "xmatrix.page-summons";
/** The most recent calls this device remembers; an older `@` reads as a plain mention again. */
const KEPT = 100;

function remembered(): PageSummon[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is PageSummon =>
      typeof item?.id === "string" && typeof item.pageId === "string" && typeof item.harness === "string"
      && typeof item.conversationId === "string" && typeof item.messageId === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The calls this reader made from pages' `@`s. Those whose message was stored are this device's memory, so the
 * `@` still shows how its call went after the page is opened again; nobody else reads them.
 */
export function usePageSummons() {
  const [summons, setSummons] = useState<readonly PageSummon[]>(remembered);
  useEffect(() => {
    const stored = summons.filter((summon) => summon.messageId).slice(-KEPT);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // A full or refused store only forgets: the `@` reads as a plain mention after a reload.
    }
  }, [summons]);
  const add = useCallback((summon: PageSummon) => setSummons((current) => [...current, summon]), []);
  const update = useCallback((id: string, change: Partial<PageSummon>) =>
    setSummons((current) => current.map((summon) => summon.id === id ? { ...summon, ...change } : summon)), []);
  return { summons, add, update };
}
