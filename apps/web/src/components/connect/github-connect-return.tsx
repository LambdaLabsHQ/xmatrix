"use client";

import { useEffect } from "react";
import { GITHUB_CONNECT_OUTCOMES, keepGitHubConnectReturn } from "@/lib/github-connect-return";

/** Where every GitHub connect lands: it keeps the result for this tab, then opens the Space's Apps view. */
export function GitHubConnectReturn() {
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    // The grant stays out of history and of any address the app rewrites.
    window.history.replaceState(null, "", window.location.pathname);
    const reported = query.get("github");
    const outcome = GITHUB_CONNECT_OUTCOMES.find((known) => known === reported) ?? "failed";
    keepGitHubConnectReturn(outcome, query.get("grant"));
    const space = query.get("space");
    window.location.replace(space ? `/app/${encodeURIComponent(space)}/apps` : "/app");
  }, []);
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
      <h1 className="text-2xl font-semibold">Connect GitHub</h1>
      <p className="text-sm text-muted-foreground">Returning to Apps…</p>
    </main>
  );
}
