"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { WEB_PROXY_ROUTES, type LaunchTargetRepo } from "@xmatrix/protocol";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import type { OnboardingCopy } from "@/lib/onboarding-copy";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { keepGitHubReturnPath } from "@/lib/github-connect-return";
import { userErrorMessage } from "@/lib/user-facing-error";

/* "Bring your work in", the second sentence onboarding teaches, said as soon
   as an agent can answer. A Space without GitHub gets the one action that
   connects it; one with GitHub gets its repositories, each of which an agent
   drafts pages from (the page import, reviewed in Pages before it applies). */
export function BringWorkIn({ spaceId, token, copy }: { spaceId: string; token: string; copy: OnboardingCopy }) {
  const importUrl = `${WEB_PROXY_ROUTES.space_page_migration(spaceId)}/import`;
  const repositories = useQuery({
    queryKey: ["xmatrix", "page-migration", spaceId, "import-repositories"],
    queryFn: ({ signal }) => xmatrixApiRequest<{ repos: LaunchTargetRepo[]; repoStatus: string }>({
      url: `${importUrl}/repositories`, token, signal }),
  });
  const connect = useMutation({
    mutationFn: () => xmatrixApiRequest<{ url?: string }>({ url: WEB_PROXY_ROUTES.github_app_install(spaceId), token }),
    onSuccess: (payload) => {
      if (!payload.url) return;
      keepGitHubReturnPath(window.location.pathname);
      window.location.assign(payload.url);
    },
  });
  const [drafting, setDrafting] = useState<string | null>(null);
  const draft = useMutation({
    mutationFn: (repository: string) => xmatrixApiRequest<{ conversationId: string }>({
      url: importUrl, token, method: "POST", body: { repository } }),
    onSuccess: (_result, repository) => setDrafting(repository),
  });
  const status = repositories.data?.repoStatus;
  const repos = (repositories.data?.repos ?? []).slice(0, 3);
  if (status !== "not-connected" && !(status === "authorized" && repos.length > 0)) return null;
  const error = connect.error ? userErrorMessage(connect.error, "Couldn't connect the app")
    : draft.error ? userErrorMessage(draft.error, "Couldn't start drafting pages") : null;
  return (
    <div className="app-paper-tile mt-3 px-3.5 py-3" data-testid="bring-work-in">
      <p>{status === "not-connected" ? copy.bringWorkConnect : copy.bringWorkRepos}</p>
      {status === "not-connected" ? (
        <button type="button" disabled={connect.isPending} onClick={() => connect.mutate()}
          className={actionClass({ variant: "primary", size: "sm" }, "mt-2")}>
          {connect.isPending ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
          {copy.connectGitHub}
        </button>
      ) : drafting ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-muted-foreground">{copy.draftingFrom(drafting)}</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {repos.map((repo) => (
            <button key={repo.value} type="button" disabled={draft.isPending} onClick={() => draft.mutate(repo.value)}
              className={actionClass({ variant: "secondary", size: "sm" })}>{copy.draftFrom(repo.value)}</button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[13px] leading-5 text-destructive">{error}</p>}
    </div>
  );
}
