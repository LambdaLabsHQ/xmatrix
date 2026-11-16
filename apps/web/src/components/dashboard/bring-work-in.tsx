"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { WEB_PROXY_ROUTES, type LaunchTargetRepo } from "@xmatrix/protocol";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import type { OnboardingCopy } from "@/lib/onboarding-copy";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { keepGitHubReturnPath } from "@/lib/github-connect-return";
import { userErrorMessage } from "@/lib/user-facing-error";

/* Said as soon as an agent can answer: a Space without GitHub gets the one
   action that connects it, so agents can work in several repositories in
   parallel. Once GitHub is connected, nothing more is said (Daniel, 2026-11-04). */
export function BringWorkIn({ spaceId, token, copy }: { spaceId: string; token: string; copy: OnboardingCopy }) {
  const repositories = useQuery({
    queryKey: ["xmatrix", "page-migration", spaceId, "import-repositories"],
    queryFn: ({ signal }) => xmatrixApiRequest<{ repos: LaunchTargetRepo[]; repoStatus: string }>({
      url: `${WEB_PROXY_ROUTES.space_page_migration(spaceId)}/import/repositories`, token, signal }),
  });
  const connect = useMutation({
    mutationFn: () => xmatrixApiRequest<{ url?: string }>({ url: WEB_PROXY_ROUTES.github_app_install(spaceId), token }),
    onSuccess: (payload) => {
      if (!payload.url) return;
      keepGitHubReturnPath(window.location.pathname);
      window.location.assign(payload.url);
    },
  });
  if (repositories.data?.repoStatus !== "not-connected") return null;
  return (
    <div className="app-paper-tile mt-3 px-3.5 py-3" data-testid="bring-work-in">
      <p>{copy.bringWorkConnect}</p>
      <button type="button" disabled={connect.isPending} onClick={() => connect.mutate()}
        className={actionClass({ variant: "primary", size: "sm" }, "mt-2")}>
        {connect.isPending ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
        {copy.connectGitHub}
      </button>
      {connect.error && <p role="alert" className="mt-2 text-[13px] leading-5 text-destructive">
        {userErrorMessage(connect.error, "Couldn't connect the app")}</p>}
    </div>
  );
}
