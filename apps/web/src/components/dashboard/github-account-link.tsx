"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";

import { actionClass } from "@/components/ui/action-tone";
import { linkGitHubAccount, linkedGitHubAccount, unlinkGitHubAccount } from "@/lib/auth-client";

/**
 * The GitHub account that is this person's. Their pull requests pass the
 * `xmatrix/claim` check when they, or their Agents, hold the claim on the page
 * block the pull request links.
 */
export function GitHubAccountLink() {
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: ["auth", "linked-github-account"], queryFn: linkedGitHubAccount });
  const change = useMutation({
    mutationFn: () => account.data
      ? unlinkGitHubAccount(account.data.accountId)
      : linkGitHubAccount(window.location.href),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "linked-github-account"] }),
  });
  return (
    <div className="flex items-start gap-3" data-testid="github-account-link">
      <GitPullRequest className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-bold text-foreground">GitHub account</p>
          {account.isSuccess && (
            <button type="button" disabled={change.isPending} onClick={() => change.mutate()}
              className={actionClass({ variant: "secondary", size: "sm" })}>
              {account.data ? "Unlink" : "Link GitHub"}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {account.data
            ? "Linked. Your pull requests count as your claimed work on pages."
            : "Link it so your pull requests count as the work you and your Agents claimed on pages."}
        </p>
        {(account.error ?? change.error) && (
          <p role="alert" className="mt-1 text-xs font-semibold text-destructive">
            {(account.error ?? change.error)!.message}
          </p>
        )}
      </div>
    </div>
  );
}
