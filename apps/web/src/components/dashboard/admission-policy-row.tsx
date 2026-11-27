"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { actionClass } from "@/components/ui/action-tone";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";
import { admissionPolicyStanding, type AdmissionPolicyView } from "./admission-policy-standing";
import { ToolDetailSection } from "./tool-split";
import { relativeTime } from "./workspace-shell-recovered";

const TEXT = "max-h-72 overflow-auto rounded-md border border-border p-2.5 font-mono text-[12px] whitespace-pre-wrap";

/**
 * Settings › Secrets: the Space's admission policy (docs/design/admission-policy.md).
 * A first policy is adopted on a card an Agent asks with; here a person sees
 * what is in force, adopts the Page's newer text, or withdraws it.
 */
export function AdmissionPolicyRow({ spaceId, token, userId }: { spaceId: string; token: string; userId: string }) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "space-admission-policy", [spaceId]);
  const url = WEB_PROXY_ROUTES.space_admission_policy(spaceId);
  const [confirming, setConfirming] = useState(false);
  const read = useQuery({ queryKey: key, queryFn: ({ signal }) => xmatrixApiRequest<AdmissionPolicyView>({ url, token, signal }) });
  const change = useMutation({
    mutationKey: [...key, "change"],
    mutationFn: (adopt?: { address: string; value: string }) => adopt
      ? xmatrixApiRequest({ method: "PUT", url, token, body: adopt })
      : xmatrixApiRequest({ method: "DELETE", url, token }),
    onSettled: () => { setConfirming(false); return queryClient.invalidateQueries({ queryKey: key }); },
  });
  const view = read.data;
  const error = userErrorMessage(change.error ?? read.error, "Couldn't load secrets");
  const standing = view?.policy ? admissionPolicyStanding(view) : undefined;
  return (
    <ToolDetailSection title="Admission policy">
      {!view ? (
        <p className="py-4 text-sm text-muted-foreground">{read.isError ? error : "Loading…"}</p>
      ) : !view.policy || !standing ? (
        <p className="max-w-[60ch] py-4 text-sm leading-relaxed text-muted-foreground">
          None adopted: every Agent asks on a card before it uses an <b>ask</b> secret. A policy is a <code>norn 1 lib</code> block
          on a Page that says which requests need no card; an Agent proposes one on a card, and only a Space admin adopts it.
        </p>
      ) : (
        <div className="grid gap-3 py-3.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold [overflow-wrap:anywhere]">
                <a className="underline-offset-2 hover:underline"
                  href={`/app/${encodeURIComponent(spaceId)}/pages?page=${encodeURIComponent(view.policy.pageId)}`}>
                  {view.setting?.label ?? `Admission policy ${view.policy.libraryName}`}
                </a>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{standing.word} · {relativeTime(view.policy.adoptedAt)}</p>
            </div>
            {view.canAdopt && <div className="flex shrink-0 items-center gap-1">
              {confirming ? (
                <>
                  <button type="button" disabled={change.isPending} className={actionClass({ variant: "danger", size: "sm" })}
                    onClick={() => change.mutate(undefined)}>Confirm</button>
                  <button type="button" disabled={change.isPending} className={actionClass({ variant: "quiet", size: "sm" })}
                    onClick={() => setConfirming(false)}>Cancel</button>
                </>
              ) : (
                <button type="button" disabled={change.isPending} className={actionClass({ variant: "danger", size: "sm" })}
                  onClick={() => setConfirming(true)}>Withdraw</button>
              )}
            </div>}
          </div>
          {view.policy.sourceText ? <pre className={TEXT} data-admission-adopted="">{view.policy.sourceText}</pre> : null}
          {standing.note ? <p className="max-w-[60ch] text-sm text-muted-foreground whitespace-pre-wrap">{standing.note}</p> : null}
          {standing.adoptable && view.setting ? (
            <>
              <pre className={TEXT} data-admission-page-text="">{standing.adoptable}</pre>
              <div>
                <button type="button" disabled={change.isPending} className={actionClass({ variant: "primary", size: "sm" })}
                  onClick={() => change.mutate({ address: view.setting!.address, value: standing.adoptable! })}>Adopt the Page&apos;s text</button>
              </div>
            </>
          ) : null}
          {change.isError && error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
        </div>
      )}
    </ToolDetailSection>
  );
}
