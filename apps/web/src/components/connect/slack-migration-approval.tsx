"use client";

import { useEffect, useRef, useState } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { InstallationOutcome, SignInElsewhere } from "./installation-consent";

/**
 * Approves a Slack migration grant as the signed-in user. The Hub accepts it
 * only from the user whose terminal started it, so an authorize link sent by
 * someone else cannot give them this person's Slack token.
 */
export function SlackMigrationApproval() {
  const { session, loading } = useAuth();
  const grant = useRef<{ code: string; state: string } | null>(null);
  const started = useRef(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (grant.current) return;
    const query = new URLSearchParams(window.location.search);
    // Keep the one-use code in memory only; never forward it through login or app navigation.
    window.history.replaceState(null, "", window.location.pathname);
    const code = query.getAll("code"), state = query.getAll("state");
    if (code.length !== 1 || state.length !== 1) {
      setError("This Slack authorization is missing or invalid. Start the migration again from your terminal.");
      return;
    }
    grant.current = { code: code[0], state: state[0] };
  }, []);

  useEffect(() => {
    if (!session || started.current || !grant.current) return;
    started.current = true;
    xmatrixApiRequest<{ ok: boolean }>({ url: WEB_PROXY_ROUTES.slack_oauth_approve, token: session.access_token,
      method: "POST", body: grant.current, signal: AbortSignal.timeout(60_000) }).then(({ ok }) => {
      if (ok !== true) throw new Error("not approved");
      setDone(true);
    }).catch(() => {
      // Do not replay a possibly consumed code, or display provider/private error payloads.
      setError("Slack could not be connected. Sign in as the person who started the migration and run it again from the terminal.");
    });
  }, [session]);

  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
    <h1 className="text-2xl font-semibold">Connect Slack</h1>
    {error ? null : done ? <p className="text-sm">Slack is connected. Return to your terminal to finish the migration.</p>
      : loading || session ? <p className="text-sm text-muted-foreground">Connecting Slack…</p> : <SignInElsewhere>
        Sign in in a separate tab as the person who started the migration, then return here.
      </SignInElsewhere>}
    <InstallationOutcome error={error} href="/app" />
  </main>;
}
