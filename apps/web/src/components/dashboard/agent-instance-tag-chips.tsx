"use client";

/* The live instance's tags, with the changeable ones changeable in place.
 *
 * A tag reports what the instance is running on, so changing it belongs to the
 * tag rather than to a dialog somewhere else. Picking a value only stages it:
 * the row sends one channel message when the edit is confirmed, carrying a
 * statement per changed tag. That is the same message a human would type, so
 * the Hub keeps its single write path and the channel keeps one audit line for
 * one decision.
 *
 * Which tags are editable is the instance's own statement, not this file's —
 * see `agent-instance-tag-edits`.
 */

import { actionClass } from "@/components/ui/action-tone";
import { useEffect, useMemo, useState } from "react";
import type { SerializedAgentInstance } from "@xmatrix/protocol";

import { cn } from "@/lib/utils";

import {
  agentInstanceTagCommandBody,
  agentInstanceTagEdits,
  type AgentInstanceTagEdit,
} from "./agent-instance-tag-edits";
import { StatusChipBadge, type StatusChip } from "./workspace-shell-recovered";

function TagOptionList({
  edit,
  chosen,
  onChoose,
}: {
  edit: AgentInstanceTagEdit;
  chosen?: string;
  onChoose: (value: string) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={`${edit.label} options`}
      className="mt-1.5 flex w-full flex-wrap gap-1 rounded-md border border-border/60 p-1.5"
    >
      {edit.options.map((option) => {
        const selected = option.value === chosen;
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={selected}
            title={option.description || option.label}
            onClick={() => onChoose(option.value)}
            className={cn(
              "max-w-full truncate rounded-full px-2 py-0.5 text-[11px] font-medium",
              selected
                ? "border border-foreground/40 text-foreground"
                : "border border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function AgentInstanceTagChips({
  instance,
  chips,
  mention,
  onRunCommand,
}: {
  instance: SerializedAgentInstance;
  chips: StatusChip[];
  /** `@agent:<n>`, the address the command statements are written against. */
  mention?: string;
  onRunCommand?: (body: string) => void;
}) {
  const editable = Boolean(mention && onRunCommand);
  const edits = useMemo(
    () => (editable ? agentInstanceTagEdits(instance) : []),
    [editable, instance],
  );
  const [staged, setStaged] = useState<Record<string, string>>({});
  const [openChipId, setOpenChipId] = useState<string | null>(null);
  /* The message body already sent, so Apply cannot be pressed twice for the
     same edit. A switch takes a moment to come back, and until it does the
     tags look exactly as they did before Apply — an unguarded button would
     collect a second identical command in that gap. */
  const [sentBody, setSentBody] = useState<string | null>(null);

  /* A switch is confirmed by the instance reporting the new value, which
     arrives as an ordinary presence update. Once it matches, the staged value
     has nothing left to say — keeping it would leave the tag looking pending
     forever after the change it asked for already landed. */
  useEffect(() => {
    setStaged((current) => {
      const settled = edits.filter((edit) => current[edit.chipId] === edit.current);
      if (settled.length === 0) return current;
      const next = { ...current };
      for (const edit of settled) delete next[edit.chipId];
      return next;
    });
  }, [edits]);

  useEffect(() => setSentBody(null), [instance.id]);

  const body = mention ? agentInstanceTagCommandBody(mention, edits, staged) : undefined;
  const sent = body !== undefined && body === sentBody;
  const openEdit = edits.find((edit) => edit.chipId === openChipId);

  return (
    <>
      {chips.map((chip) => {
        const edit = edits.find((candidate) => candidate.chipId === chip.id);
        return (
          <StatusChipBadge
            key={chip.id}
            chip={chip}
            staged={staged[chip.id]}
            {...(edit
              ? {
                  expanded: openChipId === chip.id,
                  onToggleEditor: () =>
                    setOpenChipId((value) => (value === chip.id ? null : chip.id)),
                }
              : {})}
          />
        );
      })}
      {openEdit ? (
        <TagOptionList
          edit={openEdit}
          chosen={staged[openEdit.chipId] ?? openEdit.current}
          onChoose={(value) => {
            setStaged((current) => ({ ...current, [openEdit.chipId]: value }));
            setOpenChipId(null);
          }}
        />
      ) : null}
      {body ? (
        <div className="flex w-full items-center gap-3">
          <button
            type="button"
            disabled={sent}
            title={sent
              ? "Sent. The tag updates when the instance confirms."
              : "Send this change to the instance"}
            onClick={() => {
              onRunCommand?.(body);
              setSentBody(body);
              setOpenChipId(null);
            }}
            className={actionClass({ variant: "secondary", size: "sm" })}
          >
            {sent ? "Sent" : "Apply"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStaged({});
              setSentBody(null);
              setOpenChipId(null);
            }}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {sent ? "Discard" : "Cancel"}
          </button>
        </div>
      ) : null}
    </>
  );
}
