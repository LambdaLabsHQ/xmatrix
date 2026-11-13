"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { PageProgramStatus } from "@xmatrix/protocol";

import { drawProgramFlow, type DrawnProgramFlow } from "@/components/pages/program-flow";
import { pageApi } from "@/lib/pages/page-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

/**
 * The flow of the program a message carries (program-flow.ts), which the
 * message's Norn block draws over its text: what the program has asked, what
 * it waits for now and what it does next. A block that is only shown, in a
 * message that is no program, has none.
 */
const MessageProgramContext = createContext<ReactNode>(null);
export const MessageProgramProvider = MessageProgramContext.Provider;
export const useMessageProgramFlow = (language: string): ReactNode => {
  const flow = useContext(MessageProgramContext);
  return language === "norn" ? flow : null;
};

/** Whether a message's text has a Norn block of its own: only such a message can be a program. */
export const carriesNornBlock = (body: string): boolean => /^```norn(?:[ \t][^\n]*)?$/mu.test(body);

export function MessageProgramFlow({ spaceId, programId, token, userId, render }: {
  spaceId: string;
  /** The message: a program is known by the message that carries it. */
  programId: string;
  token: string;
  userId: string;
  /** Draws what a request asks as the conversation draws a message's words: a Page or Channel it names is a link. */
  render: (text: string) => ReactNode;
}) {
  const program = useQuery<PageProgramStatus | null>({
    queryKey: xmatrixQueryKeys.domain({ userId }, "norn-program", [spaceId, programId]), retry: false, staleTime: 15_000,
    // A program that runs is read again, as an open request's chip is, so its flow moves on as it does; one that
    // has ended does not change.
    refetchInterval: (query) => (query.state.data?.state === "running" ? 30_000 : false),
    queryFn: ({ signal }) => pageApi.program(spaceId, programId, token, signal),
  });
  const host = useRef<HTMLDivElement>(null);
  const [texts, setTexts] = useState<DrawnProgramFlow["texts"]>([]);
  const found = program.data ?? null;
  useLayoutEffect(() => {
    if (!host.current) return;
    if (!found) { host.current.replaceChildren(); setTexts([]); return; }
    const drawn = drawProgramFlow(found, { richText: true });
    host.current.replaceChildren(drawn.root);
    setTexts(drawn.texts);
  }, [found]);
  return (
    <div ref={host} className="message-program-flow" data-testid="message-program-flow">
      {texts.map((place) => createPortal(render(place.text), place.at))}
    </div>
  );
}
