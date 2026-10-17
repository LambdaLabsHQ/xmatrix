"use client";

import { useEffect } from "react";
import { WEB_PROXY_ROUTES, type SetupIntentStatus } from "@xmatrix/protocol";
import { rememberSetupIntent } from "@/components/dashboard/use-setup-intent";
import { useAuth } from "@/lib/auth-context";
import { ONBOARDING_COPY } from "@/lib/onboarding-copy";
import { useBrowserOnboardingLocale } from "@/lib/onboarding-locale";
import { xmatrixApiRequest } from "@/lib/query/api-client";

/** Where the setup link a person emailed from their phone lands on their
 * computer: after sign-in, the Space it was made for opens with the same
 * command, so either screen can approve the terminal. An expired link opens
 * the app, whose empty Space shows a fresh command. */
export function SetupLinkReturn() {
  const { loading, session } = useAuth();
  const token = session?.access_token;
  const copy = ONBOARDING_COPY[useBrowserOnboardingLocale()];
  useEffect(() => {
    if (loading) return;
    const intentId = new URLSearchParams(window.location.search).get("intent") ?? "";
    if (!token) {
      window.location.replace(`/login?next=${encodeURIComponent(`/connect/computer?intent=${encodeURIComponent(intentId)}`)}`);
      return;
    }
    void xmatrixApiRequest<SetupIntentStatus>({ url: WEB_PROXY_ROUTES.setup_intent(intentId), token })
      .then((intent) => {
        rememberSetupIntent(intent.spaceId, intent.intentId);
        window.location.replace(`/app/${encodeURIComponent(intent.spaceId)}`);
      })
      .catch(() => window.location.replace("/app"));
  }, [loading, token]);
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
      <p className="text-sm text-muted-foreground">{copy.continueSetup}</p>
    </main>
  );
}
