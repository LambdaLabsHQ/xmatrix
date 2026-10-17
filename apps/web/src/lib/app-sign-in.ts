"use client";

import { HUB_ROUTES, WEB_PROXY_ROUTES, type AuthResponse } from "@xmatrix/protocol";
import type { DesktopBridge } from "@/lib/desktop/bridge";
import { authBaseUrl, type SocialSignInProvider } from "@/lib/auth-client";
import { errorFromResponse, xmatrixRawResponse } from "@/lib/query/api-client";
import { UserFacingProblem } from "@/lib/user-facing-error";

/**
 * A desktop or phone app signing in at Google or GitHub without leaving
 * itself: the provider's page opens in the system's sign-in sheet (iOS), a
 * browser tab over the app (Android) or the browser (desktop), and the app
 * redeems the one-time code it gets back with the PKCE verifier only it holds
 * (Hub: app-sign-in.ts). No device code is shown, compared or approved.
 */
export async function signInAppWithProvider(
  bridge: DesktopBridge,
  provider: SocialSignInProvider,
  options: { ephemeral?: boolean } = {},
): Promise<AuthResponse> {
  if (!bridge.authorizeInBrowser) throw new Error("This app signs in through the browser.");
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(16);
  const start = new URL(HUB_ROUTES.app_sign_in_start, authBaseUrl());
  start.searchParams.set("provider", provider);
  start.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  start.searchParams.set("code_challenge_method", "S256");
  start.searchParams.set("state", state);

  const callback = new URL(await bridge.authorizeInBrowser({
    url: start.toString(), redirectParam: "redirect_uri", ephemeral: options.ephemeral,
  }).catch((error: unknown) => {
    // A shell's bridge may carry only the message across; its cancellation still reads as one.
    if (error instanceof Error && error.name !== "AbortError" && /\bAbortError\b/u.test(error.message)) {
      throw new DOMException("The sign-in was cancelled.", "AbortError");
    }
    throw error;
  }));
  if (callback.searchParams.get("state") !== state) {
    throw new UserFacingProblem("That sign-in answer wasn't for this app. Start the sign-in again.");
  }
  const code = callback.searchParams.get("code");
  if (!code) throw new AppSignInRefused(callback.searchParams.get("error") || "no_session");

  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.app_sign_in_token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier }),
  });
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as AuthResponse;
}

/** The provider, or the person, turned the sign-in down; `code` is the provider's or the Hub's reason. */
export class AppSignInRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AppSignInRefused";
  }
}

/**
 * A nonce for Sign in with Apple: Apple signs its SHA-256 into the identity
 * token, and the Hub checks the token against the nonce itself.
 */
export async function appleSignInNonce(): Promise<{ nonce: string; hashed: string }> {
  const nonce = randomBase64Url(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return { nonce, hashed: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

function randomBase64Url(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
