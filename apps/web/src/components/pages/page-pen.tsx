"use client";

import type { CSSProperties } from "react";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { cn } from "@/lib/utils";
import type { PresentPerson } from "./page-chrome";

/** An Agent's name as its face says it: "claude:2" is Claude. */
function penName(name: string): string {
  const base = name.split(":")[0] ?? name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * What a face without its name says under it, no wider than the face, so it never covers the text beside it:
 * how long it has thought ("19s"), or that it went quiet. Its title still says it in full.
 */
function penStatus(person: PresentPerson): string {
  return person.stalled ? "!" : person.brief ?? "…";
}

/**
 * What an Agent's face shows (§3.2). With room for its name, it is a pill in its colour: the face, its name and
 * what it is doing, and the channel its words come from when `from` is on. Without, the face alone, with a
 * short tag under it while it thinks or went quiet. While it writes, its dots run, as a chat shows typing.
 */
export function PenContent({ person, named, from = true }: { person: PresentPerson; named: boolean; from?: boolean }) {
  return (
    <>
      <IdentityAvatar kind="agent" label={person.name} imageUrl={person.avatarUrl}
        initials={person.avatarUrl ? avatarInitials(person.name) : undefined} size="sm" shape="circle"
        className="page-pen-face pointer-events-none rounded-full" />
      {named && (
        <span className="page-pen-label" aria-hidden="true">
          {penName(person.name)}
          {person.doing && person.doing !== "writing" && (
            <span className={cn("page-pen-doing", person.thinking && "is-thinking",
              person.stalled && "is-stalled")}> {person.doing}</span>
          )}
          {from && person.from && <span className="page-pen-doing"> · {person.from}</span>}
        </span>
      )}
      {!named && (person.thinking || person.stalled) && person.doing && (
        <span className={cn("page-pen-status", person.stalled && "is-stalled")} aria-hidden="true">
          {penStatus(person)}
        </span>
      )}
      {person.editing && !person.idle && (
        <span className="page-writer-dots page-pen-dots" aria-hidden="true"><i /><i /><i /></span>
      )}
    </>
  );
}

/**
 * An Agent at work in the page's margin (§4.4): the same pill as at the right edge, standing in the column with
 * the cards, on their left edge, level with the line it writes. A press opens the channel it works for.
 */
export function MarginPen({ person, open, onPress }: { person: PresentPerson; open: boolean; onPress: () => void }) {
  return (
    <div className="page-pens is-named page-margin-pen">
      <button type="button" onClick={onPress} aria-expanded={open}
        className={cn("page-pen", person.editing && "is-writing")}
        style={{ "--page-pen-color": person.color } as CSSProperties}
        aria-label={`${person.name} is ${person.editing ? "writing" : "here"}`} title={`${person.name} · ${person.detail}`}>
        <PenContent person={person} named from={false} />
      </button>
    </div>
  );
}
