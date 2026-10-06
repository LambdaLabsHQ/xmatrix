"use client";

import { Sparkles, Zap } from "lucide-react";
import { draftSummons, toggleLaunchForce } from "./summon-intent";

/**
 * Before sending, each summon in the draft says who decides whether it starts
 * an Agent: Jev reading the sentence, or the author through `launch:force`.
 * The toggle only edits the draft text — the message stays the one source of
 * the author's intent, so the CLI, a quote and the next reader see the same.
 */
export function ComposerSummonIntent({ draft, onDraftChange, textareaRef }: {
  draft: string; onDraftChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const summons = draftSummons(draft);
  if (!summons.length) return null;
  return <div className="app-composer-summon-intent" role="group" aria-label="Summon intent">
    {summons.map(({ mention, forced }) => {
      const address = mention.text.split(/\s/u)[0];
      return <span key={mention.start} className="app-composer-summon-pill" data-forced={forced ? "true" : undefined}>
        {forced ? <Zap aria-hidden="true" size={13} /> : <Sparkles aria-hidden="true" size={13} />}
        <span className="app-composer-summon-text">
          {forced ? <><strong>{address}</strong> starts directly</>
            : <>Jev decides whether <strong>{address}</strong> starts</>}
        </span>
        <button type="button" className="app-composer-summon-toggle" aria-pressed={forced}
          title={forced ? "Remove launch:force and let Jev decide" : "Add launch:force: start without Jev's intent check"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const next = toggleLaunchForce(draft, mention);
            onDraftChange(next.draft);
            requestAnimationFrame(() => {
              const input = textareaRef.current;
              if (input) { input.focus(); input.setSelectionRange(next.caret, next.caret); }
            });
          }}>
          <Zap aria-hidden="true" size={12} />{forced ? "Forced" : "Force"}
        </button>
      </span>;
    })}
  </div>;
}
