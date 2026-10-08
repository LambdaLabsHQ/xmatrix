"use client";

import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  Loader2,
  Mail,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { BrandMark } from "@/components/shared/brand-mark";
import { useAuth } from "@/lib/auth-context";
import {
  getDesktopBridge,
  type DesktopBridge,
} from "@/lib/desktop/bridge";
import { exchangeDesktopCliSession, requestCliSessionExchange } from "@/lib/desktop/session-exchange";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { WEB_PROXY_ROUTES, type AuthResponse } from "@xmatrix/protocol";
import {
  authorizationLabel,
  deviceClientLabel as getDeviceClientLabel,
  deviceProductName,
  nativeAppLabel as getNativeAppLabel,
  nativeLoginClientFromContext,
  nativeLoginReturnUrl,
  normalizeNativeLoginClient,
  type NativeLoginClient,
} from "@/lib/native-login-client";
import { errorFromResponse, isTransientFailure, xmatrixRawResponse, XMatrixApiError } from "@/lib/query/api-client";
import { isAbort, unexpectedResponse, userErrorMessage } from "@/lib/user-facing-error";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOGIN_CODE_LENGTH = 6;
const PENDING_DESKTOP_DEVICE_LOGIN_KEY = "xmatrix.pendingDesktopDeviceLogin";

type DesktopLoginState = {
  status: "idle" | "opening" | "waiting" | "complete" | "error";
  verificationUrl?: string;
  error?: string;
};

type DeviceLoginStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

type DeviceLoginPollResponse = {
  status: "pending" | "approved" | "expired";
  interval?: number;
  token?: string;
  refreshToken?: string;
  authProvider?: AuthResponse["authProvider"];
  user?: AuthResponse["user"];
  hubUrl?: string;
  relayUrl?: string;
  error?: string;
};

type PendingDesktopDeviceLogin = {
  deviceCode: string;
  verificationUrl: string;
  expiresAt: number;
  interval: number;
  pendingPollCount?: number;
};

const GoogleIcon = (props: React.ComponentProps<"svg">) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {...props}>
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="#4285F4"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="#34A853"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      fill="#FBBC05"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      fill="#EA4335"
    />
  </svg>
);

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    signInWithOtp,
    verifyOtp,
    signInWithGoogle,
    setSessionFromAuthResponse,
    user,
    session,
    loading: authLoading,
  } = useAuth();

  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"email" | "otp">("email");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cliComplete, setCliComplete] = useState(false);
  /* A device sign-in hands this account's session to whoever started it, so
     it is approved only by an explicit click after the person compares the
     code, never by opening a link while signed in. */
  const [deviceApprovalConfirmed, setDeviceApprovalConfirmed] = useState(false);
  const [desktopBridge, setDesktopBridge] = useState<DesktopBridge | null>(null);
  const [nativeClient, setNativeClient] = useState<NativeLoginClient>("desktop");
  const [desktopLogin, setDesktopLogin] = useState<DesktopLoginState>({ status: "idle" });
  const legacyCliSubmittedRef = useRef(false);
  const deviceApprovalSubmittedRef = useRef(false);
  const desktopLoginStartedRef = useRef(false);
  const desktopLoginRunRef = useRef(0);
  const desktopPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setSessionFromAuthResponseRef = useRef(setSessionFromAuthResponse);
  const otpVerificationStartedRef = useRef(false);

  const cliCallback = searchParams.get("cli_callback");
  const cliState = searchParams.get("cli_state");
  const cliHub = searchParams.get("cli_hub");
  const deviceCode = searchParams.get("device_code");
  const userCode = searchParams.get("user_code");
  const deviceClient = searchParams.get("client");
  const authError = searchParams.get("auth_error") || "";
  // Better Auth returns OAuth failures as `?error=<code>` on the URL it was
  // told to fall back to, so they land here instead of the Hub's error page.
  const oauthError = searchParams.get("error") || "";
  const nextPath = normalizeNextPath(searchParams.get("next"));
  const legacyCliContext = parseCliLoginContext(cliCallback, cliState, cliHub);
  const cliCallbackContext = isCliCallbackContext(legacyCliContext) ? legacyCliContext : null;
  const cliError = legacyCliContext?.error ?? "";
  const formError =
    cliError ||
    error ||
    authError ||
    (oauthError ? "Google sign-in did not complete. Try again, or use a login code." : "");
  const cliMode = Boolean(deviceCode || legacyCliContext);
  const awaitingDeviceConfirmation = Boolean(
    session?.access_token && deviceCode && userCode && !deviceApprovalConfirmed && !cliComplete,
  );
  const cliModeActive = cliMode && !cliError;
  const desktopMode = Boolean(desktopBridge) && !cliMode;
  const desktopModeActive = desktopMode && !user;
  const deviceClientLabel = getDeviceClientLabel(deviceClient);
  const nativeAppLabel = getNativeAppLabel(nativeClient);
  const nativeReturnUrl = nativeLoginReturnUrl(deviceClient);

  useEffect(() => {
    const bridge = getDesktopBridge();
    setDesktopBridge(bridge);
    if (!bridge) return;

    setNativeClient(normalizeNativeLoginClient(bridge.client, bridge.platform));
    void bridge
      .getContext()
      .then((context) => {
        setNativeClient(nativeLoginClientFromContext(context));
      })
      .catch((contextError: unknown) => {
        console.warn("Could not read native login context", contextError);
      });
  }, []);

  useEffect(() => {
    setSessionFromAuthResponseRef.current = setSessionFromAuthResponse;
  }, [setSessionFromAuthResponse]);

  useEffect(() => {
    return () => {
      desktopLoginRunRef.current += 1;
      if (desktopPollTimerRef.current) {
        clearTimeout(desktopPollTimerRef.current);
        desktopPollTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!cliComplete || !nativeReturnUrl) return;
    // A system browser tab opened through a native intent cannot reliably
    // close itself. Try the registered app scheme immediately; the visible
    // link below remains the user-gesture fallback when a browser blocks it.
    window.location.assign(nativeReturnUrl);
  }, [cliComplete, nativeReturnUrl]);

  useEffect(() => {
    if (!desktopBridge || cliMode || authLoading || user || desktopLoginStartedRef.current) {
      return;
    }

    const pending = readPendingDesktopDeviceLogin();
    if (!pending) {
      return;
    }

    if (Date.now() >= pending.expiresAt) {
      clearPendingDesktopDeviceLogin();
      return;
    }

    startDesktopDeviceLoginPolling(pending, desktopBridge);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resumes a pending login when its inputs change, not per render
  }, [authLoading, cliMode, desktopBridge, nextPath, user]);

  function startDesktopDeviceLoginPolling(
    pendingLogin: PendingDesktopDeviceLogin,
    bridge: DesktopBridge
  ) {
    const runId = desktopLoginRunRef.current + 1;
    desktopLoginRunRef.current = runId;
    desktopLoginStartedRef.current = true;
    if (desktopPollTimerRef.current) {
      clearTimeout(desktopPollTimerRef.current);
      desktopPollTimerRef.current = null;
    }
    setError("");
    setDesktopLogin({
      status: "waiting",
      verificationUrl: pendingLogin.verificationUrl,
    });

    const loginRunIsCurrent = () => desktopLoginRunRef.current === runId;
    let pollInterval = Math.max(5, pendingLogin.interval || 5);
    let pendingPollCount = Math.max(0, pendingLogin.pendingPollCount || 0);

    async function pollForApproval() {
      if (!loginRunIsCurrent()) return;

      if (Date.now() >= pendingLogin.expiresAt) {
        clearPendingDesktopDeviceLogin();
        desktopLoginStartedRef.current = false;
        setDesktopLogin({
          status: "error",
          verificationUrl: pendingLogin.verificationUrl,
          error: "Browser login expired. Start a fresh sign-in.",
        });
        return;
      }

      try {
        const tokenResponse = await xmatrixRawResponse(WEB_PROXY_ROUTES.cli_device_token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: pendingLogin.deviceCode }),
        });

        if (!tokenResponse.ok) throw await errorFromResponse(tokenResponse);
        const payload = (await tokenResponse.json().catch(() => ({}))) as DeviceLoginPollResponse;

        if (payload.status === "approved") {
          pendingPollCount = 0;
          if (!payload.token || !payload.refreshToken || !payload.user || !payload.hubUrl || !payload.relayUrl) {
            throw new Error("Browser login response was incomplete");
          }

          clearPendingDesktopDeviceLogin();
          if (bridge.saveCliSession) {
            const cliSession = await exchangeDesktopCliSession(payload.token);
            await bridge.saveCliSession(cliSession);
            await bridge.startDaemon?.();
          }

          await setSessionFromAuthResponseRef.current({
            token: payload.token,
            refreshToken: payload.refreshToken,
            authProvider: payload.authProvider,
            user: payload.user,
            hubUrl: payload.hubUrl,
            relayUrl: payload.relayUrl,
          });
          setDesktopLogin({ status: "complete" });
          router.replace(nextPath || "/app");
          return;
        }

        if (payload.status === "expired") {
          clearPendingDesktopDeviceLogin();
          desktopLoginStartedRef.current = false;
          setDesktopLogin({
            status: "error",
            verificationUrl: pendingLogin.verificationUrl,
            error: "Browser login expired. Start a fresh sign-in.",
          });
          return;
        }

        pendingPollCount += 1;
        const serverInterval = Math.max(5, payload.interval || pollInterval);
        pollInterval = Math.min(30, serverInterval * Math.max(1, Math.ceil(pendingPollCount / 3)));
        writePendingDesktopDeviceLogin({ ...pendingLogin, interval: pollInterval, pendingPollCount });
        desktopPollTimerRef.current = setTimeout(pollForApproval, pollInterval * 1000);
      } catch (nextError) {
        if (Date.now() < pendingLogin.expiresAt && isTransientDeviceLoginPollError(nextError)) {
          pollInterval = Math.min(30, Math.max(5, pollInterval));
          setDesktopLogin({
            status: "waiting",
            verificationUrl: pendingLogin.verificationUrl,
          });
          desktopPollTimerRef.current = setTimeout(pollForApproval, pollInterval * 1000);
          return;
        }

        clearPendingDesktopDeviceLogin();
        desktopLoginStartedRef.current = false;
        setDesktopLogin({
          status: "error",
          verificationUrl: pendingLogin.verificationUrl,
          error: formatLoginError(nextError),
        });
      }
    }

    void pollForApproval();
  }

  async function handleDesktopBrowserLogin() {
    if (!desktopBridge || cliMode || authLoading || user || desktopLoginStartedRef.current) {
      return;
    }

    const bridge = desktopBridge;
    clearPendingDesktopDeviceLogin();
    if (desktopPollTimerRef.current) {
      clearTimeout(desktopPollTimerRef.current);
      desktopPollTimerRef.current = null;
    }
    setError("");
    setDesktopLogin({ status: "opening" });

    try {
      const startResponse = await xmatrixRawResponse(WEB_PROXY_ROUTES.cli_device_start, {
        method: "POST",
      });

      if (!startResponse.ok) throw await errorFromResponse(startResponse);

      const deviceLogin = (await startResponse.json()) as DeviceLoginStartResponse;
      const verificationUrl = new URL(deviceLogin.verificationUriComplete);
      verificationUrl.searchParams.set("client", nativeClient);
      const pendingLogin: PendingDesktopDeviceLogin = {
        deviceCode: deviceLogin.deviceCode,
        verificationUrl: verificationUrl.toString(),
        expiresAt: Date.now() + deviceLogin.expiresIn * 1000,
        interval: Math.max(5, deviceLogin.interval || 5),
        pendingPollCount: 0,
      };

      writePendingDesktopDeviceLogin(pendingLogin);
      setDesktopLogin({
        status: "waiting",
        verificationUrl: pendingLogin.verificationUrl,
      });
      await bridge.openExternal(pendingLogin.verificationUrl);
      startDesktopDeviceLoginPolling(pendingLogin, bridge);
    } catch (nextError) {
      clearPendingDesktopDeviceLogin();
      desktopLoginStartedRef.current = false;
      setDesktopLogin({
        status: "error",
        error: formatLoginError(nextError),
      });
    }
  }

  useEffect(() => {
    async function approveDeviceLogin() {
      if (
        !session?.access_token ||
        !deviceCode ||
        !userCode ||
        !deviceApprovalConfirmed ||
        deviceApprovalSubmittedRef.current
      ) {
        return;
      }

      deviceApprovalSubmittedRef.current = true;
      setLoading(true);
      setError("");

      try {
        await approveDeviceLoginWithRetry(session.access_token, deviceCode, userCode);

        setError("");
        setCliComplete(true);
      } catch (nextError) {
        if (isDeviceLoginAlreadyCompletedError(nextError)) {
          setError("");
          setCliComplete(true);
          return;
        }
        deviceApprovalSubmittedRef.current = false;
        setDeviceApprovalConfirmed(false);
        setError(userErrorMessage(nextError, "Couldn't approve the terminal sign-in") ?? "");
      } finally {
        setLoading(false);
      }
    }

    async function completeLegacyCliLogin() {
      if (
        !session?.access_token ||
        !cliCallbackContext ||
        legacyCliSubmittedRef.current
      ) {
        return;
      }

      legacyCliSubmittedRef.current = true;
      setLoading(true);
      setError("");

      try {
        const cliSession = await requestCliSessionExchange(session.access_token);
        if (!cliSession.token || !cliSession.user || !cliSession.hubUrl || !cliSession.relayUrl) {
          throw unexpectedResponse("The terminal session");
        }

        const callbackUrl = new URL(cliCallbackContext.callbackUrl);
        const response = await xmatrixRawResponse(callbackUrl.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            token: cliSession.token,
            refresh_token: cliSession.refreshToken,
            state: cliCallbackContext.state,
          }),
        });

        if (!response.ok) throw await errorFromResponse(response);

        setCliComplete(true);
      } catch (nextError) {
        legacyCliSubmittedRef.current = false;
        setError(userErrorMessage(nextError, "Couldn't hand the session to your terminal") ?? "");
      } finally {
        setLoading(false);
      }
    }

    if (deviceCode) {
      void approveDeviceLogin();
      return;
    }

    if (legacyCliContext) {
      void completeLegacyCliLogin();
      return;
    }

    if (user) {
      router.replace(nextPath || "/app");
    }
  }, [
    cliCallbackContext,
    deviceApprovalConfirmed,
    deviceCode,
    userCode,
    legacyCliContext,
    nextPath,
    router,
    session?.access_token,
    user,
  ]);

  async function handleGoogleLogin() {
    setError("");
    setLoading(true);
    try {
      await signInWithGoogle(
        cliMode ? window.location.href : nextPath ? `${window.location.origin}${nextPath}` : undefined,
      );
    } catch (nextError) {
      setError(formatLoginError(nextError));
      setLoading(false);
    }
  }

  async function handleSendEmail(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      await signInWithOtp(email.trim());
      setStep("otp");
    } catch (nextError) {
      setError(formatLoginError(nextError));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(event: FormEvent) {
    event.preventDefault();
    if (loading || otpVerificationStartedRef.current || otp.length !== LOGIN_CODE_LENGTH) {
      return;
    }

    otpVerificationStartedRef.current = true;
    setError("");
    setLoading(true);

    try {
      await verifyOtp(email.trim(), otp.trim());
      if (!cliMode) {
        router.push(nextPath || "/app");
      }
    } catch (nextError) {
      setError(formatLoginError(nextError));
      otpVerificationStartedRef.current = false;
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="site-page site-login flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, oklch(1 0 0 / 4%) 1px, transparent 0)",
          backgroundSize: "40px 40px",
        }}
      />

      <div className="relative z-10 w-full max-w-sm">
        <BrandMark href="/" className="mb-10 justify-center" iconClassName="size-10" wordmarkClassName="text-xl" />

        <div
          className={cn(
            "site-login-panel rounded-xl border bg-card p-6 shadow-lg shadow-black/5",
            cliError
              ? "border-destructive/40"
              : cliModeActive
                ? "border-primary/30 shadow-primary/5"
                : "border-border"
          )}
        >
          <div className="space-y-3">
            {cliModeActive ? (
              <Badge className="gap-1.5">
                <ShieldCheck className="size-3.5" />
                {authorizationLabel(deviceClient)}
              </Badge>
            ) : null}
            {desktopModeActive ? (
              <Badge className="gap-1.5">
                <ExternalLink className="size-3.5" />
                {nativeClient === "ios"
                  ? "iOS Sign-in"
                  : nativeClient === "android"
                    ? "Android Sign-in"
                    : "Browser Sign-in"}
              </Badge>
            ) : null}
            {cliError ? (
              <Badge variant="destructive" className="gap-1.5">
                <AlertTriangle className="size-3.5" />
                Invalid Callback
              </Badge>
            ) : null}

            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                {cliComplete
                  ? deviceClient === "desktop"
                    ? "Desktop login complete"
                    : deviceClient === "ios"
                      ? "iOS login complete"
                      : deviceClient === "android"
                        ? "Android login complete"
                    : "CLI login complete"
                  : cliError
                    ? "This CLI sign-in link is not trusted"
                    : cliMode
                      ? deviceClient === "desktop"
                        ? "Authorize xMatrix Desktop"
                        : deviceClient === "ios"
                          ? "Authorize xMatrix iOS"
                          : deviceClient === "android"
                            ? "Authorize xMatrix Android"
                        : "Authorize xMatrix CLI"
                      : desktopModeActive
                        ? desktopLogin.status === "error"
                          ? "Browser sign-in failed"
                          : desktopLogin.status === "idle"
                            ? "Sign in to xMatrix"
                          : "Sign in in your browser"
                      : step === "email"
                        ? "Sign in to xMatrix"
                        : "Check your email"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {cliComplete
                  ? deviceClient === "desktop"
                    ? "You can return to xMatrix. The desktop session is ready."
                    : deviceClient === "ios"
                      ? "You can return to xMatrix. The iOS session is ready."
                      : deviceClient === "android"
                        ? "You can return to xMatrix. The Android session is ready."
                    : "You can return to your terminal. The CLI session is ready."
                  : cliError
                    ? "xMatrix only returns CLI sessions to loopback addresses on this device. Start a fresh login from your terminal."
                    : cliMode
                      ? deviceCode
                        ? awaitingDeviceConfirmation
                          ? `Approve only if your ${deviceClientLabel} shows this code. Approving signs it in as you.`
                          : `Finish sign-in on xmatrix.sh to approve code ${userCode || "shown in your client"} for your ${deviceClientLabel}.`
                        : `Finish sign-in to send your session back to the terminal on this device${cliCallbackContext?.hubHost ? ` for ${cliCallbackContext.hubHost}` : ""}.`
                      : desktopModeActive
                        ? desktopLogin.status === "error"
                          ? desktopLogin.error || "Start a fresh browser sign-in."
                          : desktopLogin.status === "idle"
                            ? "Open your system browser when you're ready to sign in."
                            : `Complete authentication in your system browser. The ${nativeAppLabel} will continue automatically when sign-in finishes.`
                      : step === "email"
                        ? "We'll send you a secure verification code."
                        : `We sent a ${LOGIN_CODE_LENGTH}-digit verification code to ${email}.`}
              </p>
            </div>
          </div>

          {cliComplete ? (
            <div className="mt-6 space-y-4">
              {nativeReturnUrl ? (
                <Button nativeButton={false} className="w-full" render={<a href={nativeReturnUrl} />}>
                  Return to xMatrix
                </Button>
              ) : (
                <Button type="button" className="w-full" onClick={() => window.close()}>
                  {deviceClient === "desktop" || deviceClient === "ios" || deviceClient === "android"
                    ? "Return to xMatrix"
                    : "Return to terminal"}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className="w-full text-xs text-muted-foreground"
                onClick={() => router.push("/app")}
              >
                Open xMatrix
              </Button>
            </div>
          ) : cliError ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Run this again from your terminal:</p>
                <p className="mt-2 rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
                  xmatrix login
                </p>
              </div>
              <Button nativeButton={false} className="w-full" render={<Link href="/docs" />}>
                Open Docs
              </Button>
              <Button nativeButton={false} variant="ghost" className="w-full" render={<Link href="/" />}>
                Back to Home
              </Button>
            </div>
          ) : awaitingDeviceConfirmation ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-lg border border-border bg-muted/40 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Verification code
                </p>
                <p className="mt-2 font-mono text-2xl font-semibold tracking-[0.2em] text-foreground"
                  data-testid="device-approval-code">
                  {userCode}
                </p>
                {user?.email ? (
                  <p className="mt-2 text-xs text-muted-foreground">Signing in as {user.email}</p>
                ) : null}
              </div>
              <Button type="button" className="w-full" onClick={() => setDeviceApprovalConfirmed(true)}>
                Approve
              </Button>
              <Button type="button" variant="ghost" className="w-full text-xs text-muted-foreground"
                onClick={() => router.replace("/app")}>
                This is not my code
              </Button>
            </div>
          ) : desktopModeActive ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2 text-foreground">
                  {desktopLogin.status === "idle" ? (
                    <ExternalLink className="size-4 text-primary" />
                  ) : desktopLogin.status === "error" ? (
                    <AlertTriangle className="size-4 text-destructive" />
                  ) : (
                    <Loader2 className="size-4 animate-spin text-primary" />
                  )}
                  <span className="font-medium">
                    {desktopLogin.status === "idle"
                      ? "Browser sign-in is ready"
                      : desktopLogin.status === "error"
                      ? "Could not finish browser sign-in"
                      : desktopLogin.status === "opening"
                        ? "Opening your browser"
                        : "Waiting for browser approval"}
                  </span>
                </div>
                <p className="mt-2">
                  {desktopLogin.status === "idle"
                    ? "xMatrix will start sign-in only after you choose to continue."
                    : `Keep this window open while you finish signing in. The ${nativeAppLabel} will update as soon as the browser session is approved.`}
                </p>
              </div>

              {desktopLogin.error ? (
                <p className="text-sm text-destructive">{desktopLogin.error}</p>
              ) : null}

              {desktopLogin.verificationUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => desktopBridge?.openExternal(desktopLogin.verificationUrl!)}
                >
                  <ExternalLink className="mr-2 size-4" />
                  Open browser again
                </Button>
              ) : null}

              {desktopLogin.status === "idle" || desktopLogin.status === "error" ? (
                <Button
                  type="button"
                  className="w-full"
                  onClick={handleDesktopBrowserLogin}
                  disabled={authLoading}
                >
                  <ExternalLink className="mr-2 size-4" />
                  {desktopLogin.status === "error" ? "Start a fresh sign-in" : "Sign in with browser"}
                </Button>
              ) : null}
            </div>
          ) : step === "email" ? (
            <form onSubmit={handleSendEmail} className="mt-6 space-y-4">
              {cliMode ? (
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  This browser session was opened by{" "}
                  <code className="rounded bg-background px-1 py-0.5 text-xs">
                    {deviceProductName(deviceClient)}
                  </code>
                  . After you sign in, xMatrix will authorize your {deviceClientLabel} session
                  {deviceCode ? ` with verification code ${userCode || "shown in your client"}` : " on this device"}.
                </div>
              ) : null}

              <div className="space-y-1.5">
                <label htmlFor="login-email" className="text-sm font-medium">
                  Email address
                </label>
                <Input
                  id="login-email"
                  type="email"
                  placeholder="you@example.com"
                  required
                  autoFocus
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setError("");
                  }}
                />
              </div>

              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}

              <Button type="submit" className="w-full" disabled={loading || Boolean(cliError)}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Sending code…
                  </>
                ) : (
                  <>
                    <Mail className="mr-2 size-4" />
                    Send login code
                  </>
                )}
              </Button>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase text-muted-foreground">
                  <span className="bg-card px-2">Or continue with</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleGoogleLogin}
                disabled={loading || Boolean(cliError)}
              >
                <GoogleIcon className="mr-2 size-4" />
                Sign in with Google
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="mt-6 space-y-4">
              {cliMode ? (
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  Enter the verification code to finish browser sign-in, then xMatrix will authorize the waiting {deviceClientLabel} session.
                </div>
              ) : null}

              <div className="space-y-1.5">
                <label htmlFor="login-otp" className="text-sm font-medium">
                  Verification Code
                </label>
                <p id="login-otp-hint" className="text-xs text-muted-foreground">
                  Enter the {LOGIN_CODE_LENGTH}-digit code from your email.
                </p>
                <Input
                  id="login-otp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern={`[0-9]{${LOGIN_CODE_LENGTH}}`}
                  required
                  autoFocus
                  value={otp}
                  onChange={(event) =>
                    setOtp(event.target.value.replace(/\D/g, "").slice(0, LOGIN_CODE_LENGTH))
                  }
                  minLength={LOGIN_CODE_LENGTH}
                  maxLength={LOGIN_CODE_LENGTH}
                  aria-describedby="login-otp-hint"
                  className="text-center tracking-[0.35em]"
                />
              </div>

              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}

              <Button
                type="submit"
                className="w-full"
                disabled={loading || otp.length !== LOGIN_CODE_LENGTH || Boolean(cliError)}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Completing sign-in…
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="ml-2 size-4" />
                  </>
                )}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full text-xs text-muted-foreground"
                onClick={() => setStep("email")}
                disabled={loading}
              >
                Back to email
              </Button>
            </form>
          )}
        </div>

        <p className="mt-5 px-3 text-center text-xs leading-5 text-muted-foreground">
          By continuing, you agree to the xMatrix{" "}
          <Link className="font-medium text-foreground underline underline-offset-4" href="/terms">
            Terms of Service
          </Link>{" "}
          and acknowledge the{" "}
          <Link className="font-medium text-foreground underline underline-offset-4" href="/privacy">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function normalizeNextPath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return "";
  }
  return next;
}

function formatLoginError(error: unknown): string {
  // Read only to recognise Better Auth's rate-limit wording; never shown.
  // eslint-disable-next-line no-restricted-syntax
  const message = error instanceof Error ? error.message : "";
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";

  if (code === "over_email_send_rate_limit" || /email rate limit/i.test(message)) {
    return "Too many login emails were requested. Use Google sign-in or wait a minute before requesting another code.";
  }

  if (code === "email_delivery_configuration_error") {
    return "Email sign-in codes are not configured. Use Google sign-in while the mail setup is fixed.";
  }

  return userErrorMessage(error, "Couldn't sign you in") ?? "";
}

/** A poll that got no answer, or the proxy's own deadline; the next poll may get one. */
function isTransientDeviceLoginPollError(error: unknown): boolean {
  return isTransientFailure(error) || isAbort(error) ||
    (error instanceof Error && error.name === "TimeoutError") ||
    (error instanceof XMatrixApiError && error.status === 504);
}

async function approveDeviceLoginWithRetry(
  accessToken: string,
  deviceCode: string,
  userCode: string
): Promise<void> {
  const delays = [0, 750, 1500];
  let lastError: unknown;

  for (const delayMs of delays) {
    if (delayMs > 0) {
      await delay(delayMs);
    }

    try {
      await approveDeviceLogin(accessToken, deviceCode, userCode);
      return;
    } catch (error) {
      if (isDeviceLoginAlreadyCompletedError(error)) {
        throw error;
      }
      if (!isTransientDeviceLoginPollError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError;
}

async function approveDeviceLogin(
  accessToken: string,
  deviceCode: string,
  userCode: string
): Promise<void> {
  const response = await xmatrixRawResponse("/api/xmatrix/cli/device/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      deviceCode,
      userCode,
    }),
  });

  if (!response.ok) throw await errorFromResponse(response);
}

function isDeviceLoginAlreadyCompletedError(error: unknown): boolean {
  return error instanceof XMatrixApiError && error.status === 404 &&
    (error.code === "unknown_device_code" || error.message === "Unknown device code");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readPendingDesktopDeviceLogin(): PendingDesktopDeviceLogin | null {
  try {
    const raw = window.localStorage.getItem(PENDING_DESKTOP_DEVICE_LOGIN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingDesktopDeviceLogin>;
    if (
      typeof value.deviceCode !== "string" ||
      typeof value.verificationUrl !== "string" ||
      typeof value.expiresAt !== "number"
    ) {
      clearPendingDesktopDeviceLogin();
      return null;
    }

    return {
      deviceCode: value.deviceCode,
      verificationUrl: value.verificationUrl,
      expiresAt: value.expiresAt,
      interval: Math.max(5, value.interval || 5),
      pendingPollCount: Math.max(0, value.pendingPollCount || 0),
    };
  } catch {
    clearPendingDesktopDeviceLogin();
    return null;
  }
}

function writePendingDesktopDeviceLogin(value: PendingDesktopDeviceLogin) {
  try {
    window.localStorage.setItem(PENDING_DESKTOP_DEVICE_LOGIN_KEY, JSON.stringify(value));
  } catch {
    // Losing this cache only prevents resume after a WebView reload.
  }
}

function clearPendingDesktopDeviceLogin() {
  try {
    window.localStorage.removeItem(PENDING_DESKTOP_DEVICE_LOGIN_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

function parseCliLoginContext(
  cliCallback: string | null,
  cliState: string | null,
  cliHub: string | null
):
  | {
      callbackUrl: string;
      state: string;
      hubHost: string | null;
      error?: undefined;
    }
  | {
      error: string;
    }
  | null {
  if (!cliCallback && !cliState && !cliHub) {
    return null;
  }

  if (!cliCallback || !cliState) {
    return {
      error: "Invalid CLI login link. Run `xmatrix login` again from your terminal.",
    };
  }

  try {
    const callbackUrl = new URL(cliCallback);
    const host = callbackUrl.hostname.toLowerCase();
    if (callbackUrl.protocol !== "http:" || !LOOPBACK_HOSTS.has(host)) {
      throw new Error("cli callback must use a loopback address");
    }

    let hubHost: string | null = null;
    if (cliHub) {
      try {
        hubHost = new URL(cliHub).host;
      } catch {
        hubHost = null;
      }
    }

    return {
      callbackUrl: callbackUrl.toString(),
      state: cliState,
      hubHost,
    };
  } catch {
    return {
      error: "Invalid CLI login link. Run `xmatrix login` again from your terminal.",
    };
  }
}

function isCliCallbackContext(
  context: ReturnType<typeof parseCliLoginContext>
): context is {
  callbackUrl: string;
  state: string;
  hubHost: string | null;
} {
  return Boolean(context && "callbackUrl" in context);
}
