"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import {
  AuthDivider,
  AuthError,
  AuthHeading,
  AuthLinks,
  AuthPrimaryButton,
  AuthRequest,
  AuthSecondaryButton,
  AuthShell,
} from "@/components/auth/auth-shell";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { useAuth } from "@/lib/auth-context";
import {
  getDesktopBridge,
  type DesktopBridge,
} from "@/lib/desktop/bridge";
import { exchangeDesktopCliSession, requestCliSessionExchange } from "@/lib/desktop/session-exchange";
import { Input } from "@/components/ui/input";
import { WEB_PROXY_ROUTES, type AuthResponse } from "@xmatrix/protocol";
import {
  deviceClientLabel as getDeviceClientLabel,
  deviceProductName,
  nativeAppLabel as getNativeAppLabel,
  nativeLoginClientFromContext,
  nativeLoginReturnUrl,
  normalizeNativeLoginClient,
  type NativeLoginClient,
} from "@/lib/native-login-client";
import { errorFromResponse, isTransientFailure, xmatrixRawResponse, XMatrixApiError, unexpectedResponse } from "@/lib/query/api-client";
import { isAbort, userErrorMessage } from "@/lib/user-facing-error";
import { isTransientAuthSessionError } from "@/lib/auth-client";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOGIN_CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;
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
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  /* The last code check got no answer: the code is unspent and can be sent again. */
  const [codeUnanswered, setCodeUnanswered] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [clock, setClock] = useState(0);
  const resendSeconds = Math.max(0, Math.ceil((resendAt - clock) / 1000));
  const otpFormRef = useRef<HTMLFormElement>(null);
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

  // Counts down the resend wait; stops once the wait is over.
  useEffect(() => {
    if (!resendAt) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (now >= resendAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  // A full code (typed, pasted or filled from the mail app) signs in at once.
  useEffect(() => {
    if (step === "otp" && otp.length === LOGIN_CODE_LENGTH) {
      otpFormRef.current?.requestSubmit();
    }
  }, [otp, step]);

  function startResendWait() {
    const now = Date.now();
    setClock(now);
    setResendAt(now + RESEND_COOLDOWN_SECONDS * 1000);
  }

  function changeEmail() {
    setStep("email");
    setOtp("");
    setError("");
    setNotice("");
    setCodeUnanswered(false);
  }

  async function handleResendCode() {
    if (loading || resendSeconds > 0) return;
    setError("");
    setNotice("");
    setOtp("");
    startResendWait();
    try {
      await signInWithOtp(email.trim());
      setNotice("We sent a new code. Use the one in the newest email.");
    } catch (nextError) {
      setError(formatLoginError(nextError));
    }
  }

  async function handleGoogleLogin() {
    setError("");
    setGoogleLoading(true);
    try {
      await signInWithGoogle(
        cliMode ? window.location.href : nextPath ? `${window.location.origin}${nextPath}` : undefined,
      );
    } catch (nextError) {
      setError(formatLoginError(nextError));
      setGoogleLoading(false);
    }
  }

  async function handleSendEmail(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      await signInWithOtp(email.trim());
      setStep("otp");
      startResendWait();
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
    setCodeUnanswered(false);
    setLoading(true);

    try {
      await verifyOtp(email.trim(), otp.trim());
      if (!cliMode) {
        router.push(nextPath || "/app");
      }
    } catch (nextError) {
      const unanswered = isTransientAuthSessionError(nextError);
      setCodeUnanswered(unanswered);
      setError(unanswered ? "Couldn't reach xMatrix. Your code still works, so try again." : formatLoginError(nextError));
      otpVerificationStartedRef.current = false;
    } finally {
      setLoading(false);
    }
  }

  const productName = deviceProductName(deviceClient);
  const signingInAs = user?.email ? <>Signing in as <strong>{user.email}</strong></> : null;

  return (
    <AuthShell legal={!cliComplete && !cliError}>
      {cliComplete ? (
        <>
          <AuthHeading title="You're signed in">
            {deviceClient === "desktop"
              ? "You can return to xMatrix. The desktop session is ready."
              : deviceClient === "ios"
                ? "You can return to xMatrix. The iOS session is ready."
                : deviceClient === "android"
                  ? "You can return to xMatrix. The Android session is ready."
                  : "You can return to your terminal. The CLI session is ready."}
          </AuthHeading>
          <div className="auth-stack">
            {nativeReturnUrl ? (
              <WoodPanel as="a" href={nativeReturnUrl} className="site-wood-pill auth-button">
                Return to xMatrix
              </WoodPanel>
            ) : (
              <AuthPrimaryButton onClick={() => window.close()}>
                {deviceClient === "desktop" || deviceClient === "ios" || deviceClient === "android"
                  ? "Return to xMatrix"
                  : "Close this tab"}
              </AuthPrimaryButton>
            )}
            <AuthSecondaryButton onClick={() => router.push("/app")}>Open xMatrix here</AuthSecondaryButton>
          </div>
        </>
      ) : cliError ? (
        <>
          <AuthHeading title="This sign-in link isn't trusted">
            xMatrix only returns CLI sessions to loopback addresses on this device. Start a fresh
            login from your terminal.
          </AuthHeading>
          <AuthRequest icon={<AlertTriangle className="size-4" />} title="Run this again in your terminal">
            <code className="auth-command">xmatrix login</code>
          </AuthRequest>
          <AuthLinks>
            <Link href="/docs">Open Docs</Link>
            <Link href="/">Back to Home</Link>
          </AuthLinks>
        </>
      ) : awaitingDeviceConfirmation ? (
        <>
          <AuthHeading title={`Approve ${productName}?`}>
            Approve only if your {deviceClientLabel} shows this code. Approving signs it in as you.
          </AuthHeading>
          <AuthRequest
            icon={<ShieldCheck className="size-4" />}
            title={`${productName} is asking to sign in`}
            code={userCode}
          >
            {signingInAs}
          </AuthRequest>
          <AuthError>{formError}</AuthError>
          <div className="auth-stack">
            <AuthPrimaryButton onClick={() => setDeviceApprovalConfirmed(true)} disabled={loading}>
              {loading ? <Spinner /> : null}
              Approve
            </AuthPrimaryButton>
            <AuthSecondaryButton onClick={() => router.replace("/app")} disabled={loading}>
              This is not my code
            </AuthSecondaryButton>
          </div>
        </>
      ) : desktopModeActive ? (
        <>
          <AuthHeading
            title={
              desktopLogin.status === "error"
                ? "Browser sign-in didn't finish"
                : desktopLogin.status === "idle"
                  ? "Welcome to xMatrix"
                  : "Continue in your browser"
            }
          >
            {desktopLogin.status === "error"
              ? "Start a fresh sign-in to try again."
              : desktopLogin.status === "idle"
                ? `Sign in or create your account in your browser. The ${nativeAppLabel} continues on its own when you're done.`
                : `Keep this window open. The ${nativeAppLabel} continues as soon as the browser approves the sign-in.`}
          </AuthHeading>
          {desktopLogin.status === "opening" || desktopLogin.status === "waiting" ? (
            <AuthRequest
              icon={<Spinner />}
              title={desktopLogin.status === "opening" ? "Opening your browser…" : "Waiting for your browser…"}
            />
          ) : null}
          <AuthError>{desktopLogin.error}</AuthError>
          <div className="auth-stack">
            {desktopLogin.status === "idle" || desktopLogin.status === "error" ? (
              <AuthPrimaryButton onClick={handleDesktopBrowserLogin} disabled={authLoading}>
                <ExternalLink className="size-4" />
                {desktopLogin.status === "error" ? "Start a fresh sign-in" : "Sign in with browser"}
              </AuthPrimaryButton>
            ) : null}
            {desktopLogin.verificationUrl ? (
              <AuthSecondaryButton onClick={() => desktopBridge?.openExternal(desktopLogin.verificationUrl!)}>
                Open browser again
              </AuthSecondaryButton>
            ) : null}
          </div>
        </>
      ) : step === "email" ? (
        <>
          <AuthHeading title={cliMode ? `Sign in to approve ${productName}` : "Welcome to xMatrix"}>
            {cliMode
              ? `Your ${deviceClientLabel} is waiting. After you sign in, you'll confirm its code before anything is shared.`
              : "Sign in or create your account. New accounts start free."}
          </AuthHeading>
          {cliMode && deviceCode ? (
            <AuthRequest icon={<ShieldCheck className="size-4" />} title={`${productName} is asking to sign in`}>
              Code <span className="auth-inline-code">{userCode || "shown in your client"}</span>
            </AuthRequest>
          ) : null}
          <div className="auth-stack">
            <AuthSecondaryButton onClick={handleGoogleLogin} disabled={loading || googleLoading}>
              {googleLoading ? <Spinner /> : <GoogleIcon className="size-[18px]" />}
              Continue with Google
            </AuthSecondaryButton>
            <AuthDivider />
            <form onSubmit={handleSendEmail} className="auth-stack">
              <label htmlFor="login-email" className="auth-label">
                Email address
              </label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                autoFocus
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError("");
                }}
                className="auth-input"
              />
              <AuthError>{formError}</AuthError>
              <AuthPrimaryButton type="submit" disabled={loading || googleLoading}>
                {loading ? <Spinner /> : null}
                {loading ? "Sending code…" : "Continue with email"}
              </AuthPrimaryButton>
            </form>
          </div>
          <AuthLinks>
            <Link href={`/login/password${searchParams.toString() ? `?${searchParams}` : ""}`}>
              Sign in with password
            </Link>
          </AuthLinks>
        </>
      ) : (
        <>
          <AuthHeading title="Check your email">
            Enter the {LOGIN_CODE_LENGTH}-digit code we sent to <strong>{email}</strong>.{" "}
            <button type="button" className="auth-text-button" onClick={changeEmail} disabled={loading}>
              Change
            </button>
          </AuthHeading>
          <form ref={otpFormRef} onSubmit={handleVerifyOtp} className="auth-stack">
            <label htmlFor="login-otp" className="auth-label">
              Login code
            </label>
            <Input
              id="login-otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern={`[0-9]{${LOGIN_CODE_LENGTH}}`}
              required
              autoFocus
              value={otp}
              onChange={(event) => {
                setOtp(event.target.value.replace(/\D/g, "").slice(0, LOGIN_CODE_LENGTH));
                setError("");
                setNotice("");
                setCodeUnanswered(false);
              }}
              minLength={LOGIN_CODE_LENGTH}
              maxLength={LOGIN_CODE_LENGTH}
              aria-describedby="login-otp-hint"
              placeholder={"0".repeat(LOGIN_CODE_LENGTH)}
              className="auth-input auth-code-input"
            />
            <p id="login-otp-hint" className="auth-hint">
              {cliMode
                ? `After this, you'll confirm the ${deviceClientLabel} sign-in.`
                : "The code works for 5 minutes. Not there? Check spam."}
            </p>
            <AuthError>{formError}</AuthError>
            {notice ? <p role="status" className="auth-hint">{notice}</p> : null}
            <AuthPrimaryButton type="submit" disabled={loading || otp.length !== LOGIN_CODE_LENGTH}>
              {loading ? <Spinner /> : null}
              {loading ? "Signing in…" : codeUnanswered ? "Try again" : "Sign in"}
              {loading ? null : <ArrowRight className="size-4" />}
            </AuthPrimaryButton>
          </form>
          <AuthLinks>
            <button type="button" className="auth-text-button" onClick={handleResendCode}
              disabled={loading || resendSeconds > 0}>
              {resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : "Resend code"}
            </button>
          </AuthLinks>
        </>
      )}
    </AuthShell>
  );
}

function Spinner() {
  return <AnimatedIcon icon={Loader2} className="size-4 animate-spin" />;
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

  if (code === "INVALID_OTP") {
    return "That code didn't match. Check the newest email, or resend a code.";
  }

  if (code === "OTP_EXPIRED") {
    return "That code has expired. Resend a new one.";
  }

  if (code === "TOO_MANY_ATTEMPTS") {
    return "Too many tries with this code. Resend a new one.";
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
