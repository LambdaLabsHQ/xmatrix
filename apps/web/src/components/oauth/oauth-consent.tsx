"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { answerOAuthConsent, readOAuthClient, type OAuthClientSummary } from "@/lib/auth-client";

/** What each scope lets an outside app do, in the person's terms. */
const SCOPE_TEXT: Record<string, string> = {
  "xmatrix:read": "Read the pages and channels you can read in your Spaces",
  "xmatrix:write": "Edit pages and send messages as you",
  email: "See your email address",
  profile: "See your name and picture",
  offline_access: "Stay connected until you remove it",
};

/**
 * An outside AI app (ChatGPT, Grok, Cursor…) asks to reach the person's
 * xMatrix. Nothing is granted until they choose; the app acts with exactly
 * their own access and can be removed later.
 */
export function OAuthConsent() {
  const { user, loading } = useAuth();
  // Read after mount: the server render has no query to agree with.
  const [query, setQuery] = useState<URLSearchParams | null>(null);
  useEffect(() => setQuery(new URLSearchParams(window.location.search)), []);
  const [client, setClient] = useState<OAuthClientSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const clientId = query?.get("client_id") ?? "";
  const returnHost = (() => { try { return new URL(query?.get("redirect_uri") ?? "").host; } catch { return ""; } })();
  const requested = new Set((query?.get("scope") ?? "").split(" "));
  const scopes = Object.keys(SCOPE_TEXT).filter((scope) => requested.has(scope));

  useEffect(() => {
    if (!user || !clientId) return;
    readOAuthClient(clientId).then(setClient).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "This app's request could not be read."));
  }, [clientId, user]);

  async function answer(accept: boolean) {
    if (!query) return;
    setPending(true);
    setError("");
    try {
      window.location.assign(await answerOAuthConsent(accept, query));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your answer could not be sent. Try again.");
      setPending(false);
    }
  }

  const appName = client?.name ?? "An app";
  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
    <h1 className="text-2xl font-semibold">{appName} wants to use your xMatrix</h1>
    {!query ? <p className="text-sm text-muted-foreground">Reading the request…</p>
      : !clientId ? <p role="alert" className="text-sm text-destructive">This request is missing or invalid. Start again from the app.</p>
      : loading || (user && !client && !error) ? <p className="text-sm text-muted-foreground">Reading the request…</p>
      : !user ? <p className="text-sm">Sign in to xMatrix, then start again from the app.</p>
      : <>
        <p className="text-sm">Signed in as {user.email}. {appName} will be able to:</p>
        <ul className="list-disc space-y-1 pl-5 text-sm">{scopes.map((scope) => <li key={scope}>{SCOPE_TEXT[scope]}</li>)}</ul>
        <p className="text-sm text-muted-foreground">It acts as you, with only the access you have. You can remove it at any time.</p>
        {/* The app names itself when it registers; where the grant goes is what can be trusted. */}
        {returnHost ? <p className="text-xs text-muted-foreground">Allowing sends you back to {returnHost}.</p> : null}
        <div className="flex gap-3">
          <Button disabled={pending} onClick={() => void answer(true)}>Allow</Button>
          <Button variant="outline" disabled={pending} onClick={() => void answer(false)}>Deny</Button>
        </div>
      </>}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </main>;
}
