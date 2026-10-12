"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { oauthAuthorizeUrl } from "@/lib/auth-client";

/**
 * Where the Hub sends an outside AI app's sign-in when nobody is signed in:
 * the person signs in here as usual, then the app's request resumes at the
 * Hub, which asks their consent.
 */
export function OAuthAuthorizeHandoff() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    const query = new URLSearchParams(window.location.search);
    if (!query.get("client_id")) return;
    if (user) window.location.replace(oauthAuthorizeUrl(query));
    else router.replace(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  }, [loading, router, user]);

  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-3 px-6 py-12">
    <h1 className="text-2xl font-semibold">Sign in to xMatrix</h1>
    <p className="text-sm text-muted-foreground">Taking you to sign in…</p>
  </main>;
}
