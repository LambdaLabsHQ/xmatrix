"use client";

import { useCallback, useEffect, useState } from "react";
import { Star } from "lucide-react";
import { actionClass } from "@/components/ui/action-tone";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import {
  AGENT_ANSWERED_EVENT,
  REPOSITORY_URL,
  afterAgentAnswer,
  afterOpeningRepository,
  afterPutOff,
  askStillWanted,
  isStarPromptRecordChange,
  readStarPromptRecord,
  starPromptStorage,
  writeStarPromptRecord,
} from "@/lib/star-prompt";

/** Opens the repository so the person can star it there, and ends the asking. */
export function openRepositoryToStar(): void {
  const storage = starPromptStorage();
  writeStarPromptRecord(storage, afterOpeningRepository(readStarPromptRecord(storage)));
  const bridge = getDesktopBridge();
  if (bridge?.openExternal) void bridge.openExternal(REPOSITORY_URL);
  else window.open(REPOSITORY_URL, "_blank", "noopener");
}

/**
 * Whether an ask is due, counted from the Agent answers this browser sees.
 * An ask stays until it is answered; a second tab that answers it settles
 * this one too.
 */
export function useStarPrompt(): { asking: boolean; putOff: () => void; settle: () => void } {
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const onAnswer = () => {
      const storage = starPromptStorage();
      const { record, ask } = afterAgentAnswer(readStarPromptRecord(storage), Date.now());
      writeStarPromptRecord(storage, record);
      if (ask) setAsking(true);
    };
    const onRecordChange = (event: StorageEvent) => {
      if (!isStarPromptRecordChange(event)) return;
      if (!askStillWanted(readStarPromptRecord(starPromptStorage()), Date.now())) setAsking(false);
    };
    window.addEventListener(AGENT_ANSWERED_EVENT, onAnswer);
    window.addEventListener("storage", onRecordChange);
    return () => {
      window.removeEventListener(AGENT_ANSWERED_EVENT, onAnswer);
      window.removeEventListener("storage", onRecordChange);
    };
  }, []);

  const putOff = useCallback(() => {
    const storage = starPromptStorage();
    writeStarPromptRecord(storage, afterPutOff(readStarPromptRecord(storage), Date.now()));
    setAsking(false);
  }, []);
  const settle = useCallback(() => setAsking(false), []);

  return { asking, putOff, settle };
}

/** The ask itself. Its frame and position belong to whoever shows it. */
export function StarAsk({ onStar, onLater }: { onStar: () => void; onLater: () => void }) {
  return (
    <>
      <p id="star-ask-title" className="flex items-center gap-1.5 text-sm font-bold">
        <Star className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        Enjoying xMatrix?
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        If it helped today, a GitHub star helps other developers find it.
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <button type="button" className={actionClass({ variant: "primary", size: "sm" })} onClick={onStar}>
          Star on GitHub
        </button>
        <button type="button" className={actionClass({ variant: "quiet", size: "sm" })} onClick={onLater}>
          Later
        </button>
      </div>
    </>
  );
}
