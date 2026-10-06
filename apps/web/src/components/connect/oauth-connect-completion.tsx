"use client";

import { useEffect, useRef, useState } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { InstallationOutcome, SignInElsewhere } from "./installation-consent";

const CALLBACK_KEYS = ["state", "code", "configurationId", "teamId", "next"] as const;
type CallbackParams = Partial<Record<(typeof CALLBACK_KEYS)[number], string>>;

/**
 * Finishes a one-click connect as the signed-in admin. The Hub exchanges the
 * grant only when that admin started the connect, so a connect link sent by
 * someone else cannot store this person's account in another Space.
 */
export function OAuthConnectCompletion() {
  const { session, loading } = useAuth();
  const params = useRef<CallbackParams | null>(null);
  const started = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (params.current) return;
    const query = new URLSearchParams(window.location.search);
    // Keep the one-use code in memory only; never forward it through login or app navigation.
    window.history.replaceState(null, "", window.location.pathname);
    const read: CallbackParams = {};
    for (const key of CALLBACK_KEYS) {
      const values = query.getAll(key);
      if (values.length > 1) { setError("This connect request is invalid. Start again from Apps."); return; }
      if (values.length === 1) read[key] = values[0];
    }
    if (!read.state) { setError("This connect request is missing or invalid. Start again from Apps."); return; }
    params.current = read;
  }, []);

  useEffect(() => {
    if (!session || started.current || !params.current) return;
    started.current = true;
    xmatrixApiRequest<{ redirect: string }>({ url: WEB_PROXY_ROUTES.connector_oauth_complete, token: session.access_token,
      method: "POST", body: params.current, signal: AbortSignal.timeout(60_000) }).then(({ redirect }) => {
      const target = new URL(redirect, window.location.origin);
      if (target.protocol !== "https:" && target.origin !== window.location.origin) throw new Error("unexpected redirect");
      window.location.assign(target.toString());
    }).catch(() => {
      // Do not replay a possibly consumed code, or display provider/private error payloads.
      setError("This app could not be connected. Return to Apps and start a fresh connect from the Space you want.");
    });
  }, [session]);

  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
    <h1 className="text-2xl font-semibold">Connect an app</h1>
    {error ? null : loading || session ? <p className="text-sm text-muted-foreground">Finishing the connection…</p> : <SignInElsewhere>
      Sign in in a separate tab as the Space admin who started this connect, then return here.
    </SignInElsewhere>}
    <InstallationOutcome error={error} href="/app" />
  </main>;
}
