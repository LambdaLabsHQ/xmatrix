"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { HARNESS_PROFILE_DESCRIPTION_LIMIT, WEB_PROXY_ROUTES, type AgentRegistrationSummary } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { noticeClass } from "@/components/ui/status-tone";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";

import { ToolDetailSection } from "./tool-split";

/**
 * What the Space says this harness is for, edited where it is read. The text
 * is free: automatic routing reads it as it stands when it judges whether the
 * harness suits a piece of work. One text covers every location of the
 * harness in the Space, so it is shown on the agent and not on one of its
 * machines; any location's registration carries it. `draft` is null until the
 * reader types.
 */
export function HarnessProfileSection({ registration, token, onSaved }: {
  registration: AgentRegistrationSummary;
  token?: string;
  onSaved: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = registration.profile;
  // A Hub that does not report profiles has nothing to show or edit.
  if (!profile) return null;
  const { harness, spaceId } = registration.key;
  const editable = registration.canDescribe === true && Boolean(token);
  const changed = draft !== null && draft.trim() !== profile.description;

  async function save() {
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_harness_profile_command(spaceId), token, method: "POST",
        body: { harness, description: draft.trim(), expectedRevision: profile!.revision } });
      await onSaved();
      setDraft(null);
    } catch (failure) {
      setError(userErrorMessage(failure, "Couldn't update the agent", "Couldn't save the description"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ToolDetailSection title="When to pick it">
      {editable ? (
        <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <textarea
            aria-label={`When to pick ${harness}`}
            value={draft ?? profile.description}
            rows={4}
            maxLength={HARNESS_PROFILE_DESCRIPTION_LIMIT}
            disabled={saving}
            placeholder={`What ${harness} is good at here, and what to keep away from it. Write it any way you like.`}
            onChange={(event) => { setDraft(event.target.value); setError(null); }}
            className="w-full border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          {error && <p role="alert" className={noticeClass("alert", "rounded-lg p-3")}>{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              Read when work is assigned automatically. Applies on every machine {harness} runs on in this Space.
            </p>
            {changed && <>
              <button type="button" disabled={saving} onClick={() => { setDraft(null); setError(null); }}
                className={actionClass({ variant: "secondary", size: "sm" })}>Cancel</button>
              <button type="submit" disabled={saving} className={actionClass({ variant: "primary", size: "sm" })}>
                {saving ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
                Save
              </button>
            </>}
          </div>
        </form>
      ) : profile.description ? (
        <p className="whitespace-pre-wrap break-words text-sm">{profile.description}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No description yet. A Space owner or admin, or anyone with a {harness} agent here, can write one.
        </p>
      )}
    </ToolDetailSection>
  );
}
