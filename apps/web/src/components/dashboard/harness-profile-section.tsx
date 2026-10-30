"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { APP_VIEW_SELECTION_FIELDS, HARNESS_PROFILE_DESCRIPTION_LIMIT, WEB_PROXY_ROUTES, type AgentRegistrationSummary } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { noticeClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { HARNESS_PROFILE_COPY } from "@/lib/harness-profile-copy";
import { useOnboardingLocale } from "@/lib/onboarding-locale";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";

import { agentHarnessSelectionId } from "./agent-list-groups";
import { ToolDetailSection } from "./tool-split";
import { parseAppLocation } from "./workspace-shell-navigation";

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
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const { user } = useAuth();
  const profile = registration.profile;
  const { harness, spaceId } = registration.key;
  const copy = HARNESS_PROFILE_COPY[useOnboardingLocale(spaceId, token, user?.id)];
  const editable = registration.canDescribe === true && Boolean(token);
  // The mention menu opens this agent with `edit=profile` so the caret lands
  // in the text the list was showing.
  useEffect(() => {
    if (!editable) return;
    const url = parseAppLocation(window.location.href);
    if (url.searchParams.get("edit") !== "profile") return;
    if (url.searchParams.get(APP_VIEW_SELECTION_FIELDS.agents) !== agentHarnessSelectionId(harness)) return;
    fieldRef.current?.focus();
  }, [editable, harness]);
  // A Hub that does not report profiles has nothing to show or edit.
  if (!profile) return null;
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
    <ToolDetailSection title={copy.title}>
      {editable ? (
        <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <textarea
            ref={fieldRef}
            aria-label={copy.field(harness)}
            value={draft ?? profile.description}
            rows={4}
            maxLength={HARNESS_PROFILE_DESCRIPTION_LIMIT}
            disabled={saving}
            placeholder={copy.placeholder(harness)}
            onChange={(event) => { setDraft(event.target.value); setError(null); }}
            className="w-full border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          {error && <p role="alert" className={noticeClass("alert", "rounded-lg p-3")}>{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {copy.applies(harness)}
            </p>
            {changed && <>
              <button type="button" disabled={saving} onClick={() => { setDraft(null); setError(null); }}
                className={actionClass({ variant: "secondary", size: "sm" })}>{copy.cancel}</button>
              <button type="submit" disabled={saving} className={actionClass({ variant: "primary", size: "sm" })}>
                {saving ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
                {copy.save}
              </button>
            </>}
          </div>
        </form>
      ) : profile.description ? (
        <p className="whitespace-pre-wrap break-words text-sm">{profile.description}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {copy.empty(harness)}
        </p>
      )}
    </ToolDetailSection>
  );
}
