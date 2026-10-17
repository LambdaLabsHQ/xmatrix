"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
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
import { requestCliSessionExchange } from "@/lib/desktop/session-exchange";
import { AppSignInRefused, appleSignInNonce, signInAppWithProvider } from "@/lib/app-sign-in";
import { Input } from "@/components/ui/input";
import { APP_SIGN_IN_FINISH_PATH, WEB_PROXY_ROUTES, type AuthResponse } from "@xmatrix/protocol";
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
import { authBaseUrl, isTransientAuthSessionError, type SocialSignInProvider } from "@/lib/auth-client";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOGIN_CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;
const PENDING_DESKTOP_DEVICE_LOGIN_KEY = "xmatrix.pendingDesktopDeviceLogin";
/* The app also asks at once when it is brought back, so a long wait between polls is never needed. */
const DESKTOP_POLL_MAX_SECONDS = 10;

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

type DeviceRequestDescription = {
  createdAt: string;
  hostname?: string;
  platform?: string;
  requestedFrom?: string;
};

type PendingDesktopDeviceLogin = {
  deviceCode: string;
  verificationUrl: string;
  expiresAt: number;
  interval: number;
  pendingPollCount?: number;
};

const AppleIcon = (props: React.ComponentProps<"svg">) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.86-.76-1.47.02-2.83.86-3.59 2.17-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.41 1.2-2.47-.03-.01-2.3-.88-2.32-3.5ZM14.2 6.13c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.96-.49 2.56-1.23Z" />
  </svg>
);

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
    verifySecondFactor,
    signInWithSocial,
    signInWithApple,
    setSessionFromAuthResponse,
    logout,
    user,
    session,
    loading: authLoading,
  } = useAuth();

  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  /* A password or social sign-in that waits on the authenticator code arrives with `two_factor`. */
  const [step, setStep] = useState<"email" | "otp" | "two_factor">(
    () => searchParams.get("two_factor") ? "two_factor" : "email");
  const [secondCode, setSecondCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustDevice, setTrustDevice] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<SocialSignInProvider | "apple" | null>(null);
  /* The last code check got no answer: the code is unspent and can be sent again. */
  const [codeUnanswered, setCodeUnanswered] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [clock, setClock] = useState(0);
  const resendSeconds = Math.max(0, Math.ceil((resendAt - clock) / 1000));
  const otpFormRef = useRef<HTMLFormElement>(null);
  const secondFactorFormRef = useRef<HTMLFormElement>(null);
  const [cliComplete, setCliComplete] = useState(false);
  /* A device sign-in hands this account's session to whoever started it, so
     it is approved only by an explicit click after the person compares the
     code, never by opening a link while signed in. */
  const [deviceApprovalConfirmed, setDeviceApprovalConfirmed] = useState(false);
  /* What the waiting device says about itself, read once to show beside its code. */
  const [deviceRequest, setDeviceRequest] = useState<DeviceRequestDescription | "unknown" | null>(null);
  const [deviceDeclined, setDeviceDeclined] = useState(false);
  /* The older terminal sign-in hands a session to a local port; it too waits for an explicit click. */
  const [legacyApprovalConfirmed, setLegacyApprovalConfirmed] = useState(false);
  const [desktopBridge, setDesktopBridge] = useState<DesktopBridge | null>(null);
  const [nativeClient, setNativeClient] = useState<NativeLoginClient>("desktop");
  const [desktopLogin, setDesktopLogin] = useState<DesktopLoginState>({ status: "idle" });
  const legacyCliSubmittedRef = useRef(false);
  const deviceApprovalSubmittedRef = useRef(false);
  const desktopLoginStartedRef = useRef(false);
  const desktopLoginRunRef = useRef(0);
  const desktopPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const desktopPollNowRef = useRef<(() => void) | null>(null);
  const setSessionFromAuthResponseRef = useRef(setSessionFromAuthResponse);
  const otpVerificationStartedRef = useRef(false);
  const appSignInAttemptRef = useRef(0);

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
  const formError = cliError || error || authError || (oauthError ? socialSignInFailure(oauthError) : "");
  const cliMode = Boolean(deviceCode || legacyCliContext);
  const awaitingDeviceConfirmation = Boolean(
    session?.access_token && deviceCode && userCode && !deviceApprovalConfirmed && !cliComplete,
  );
  const awaitingLegacyConfirmation = Boolean(
    session?.access_token && cliCallbackContext && !legacyApprovalConfirmed && !cliComplete,
  );
  const desktopMode = Boolean(desktopBridge) && !cliMode;
  const desktopModeActive = desktopMode && !user;
  /* An app that can open the provider's page in place signs in right here, like the web; older ones use the browser. */
  const inAppSignIn = desktopModeActive && Boolean(desktopBridge?.authorizeInBrowser);
  const browserSignIn = desktopModeActive && !inAppSignIn;
  /* The second factor of an app's provider sign-in is asked in its sign-in sheet; the Hub hands the app its code after. */
  const continueAfterSecondFactor = appSignInContinuation(searchParams.get("continue"));
  const deviceClientLabel = getDeviceClientLabel(deviceClient);
  const nativeAppLabel = getNativeAppLabel(nativeClient);
  const nativeReturnUrl = nativeLoginReturnUrl(deviceClient);

  useEffect(() => {
    if (!awaitingDeviceConfirmation || !deviceCode || !userCode || deviceRequest !== null) return;
    let cancelled = false;
    void describeDeviceRequest(deviceCode, userCode)
      .then((description) => { if (!cancelled) setDeviceRequest(description); })
      // Not reading the description only leaves the code to compare.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [awaitingDeviceConfirmation, deviceCode, userCode, deviceRequest]);

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

    startDesktopDeviceLoginPolling(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resumes a pending login when its inputs change, not per render
  }, [authLoading, cliMode, desktopBridge, nextPath, user]);

  function startDesktopDeviceLoginPolling(pendingLogin: PendingDesktopDeviceLogin) {
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
          // Taking the session up also hands this computer's CLI its own.
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
            error: payload.error && payload.error !== "Device login request expired"
              ? payload.error : "Browser login expired. Start a fresh sign-in.",
          });
          return;
        }

        pendingPollCount += 1;
        const serverInterval = Math.max(5, payload.interval || pollInterval);
        pollInterval = Math.min(DESKTOP_POLL_MAX_SECONDS, serverInterval * Math.max(1, Math.ceil(pendingPollCount / 3)));
        writePendingDesktopDeviceLogin({ ...pendingLogin, interval: pollInterval, pendingPollCount });
        desktopPollTimerRef.current = setTimeout(pollForApproval, pollInterval * 1000);
      } catch (nextError) {
        if (Date.now() < pendingLogin.expiresAt && isTransientDeviceLoginPollError(nextError)) {
          pollInterval = Math.min(DESKTOP_POLL_MAX_SECONDS, Math.max(5, pollInterval));
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

    // Coming back to the app is when the browser has most likely finished: ask at once.
    desktopPollNowRef.current = () => {
      if (!loginRunIsCurrent()) return;
      if (desktopPollTimerRef.current) clearTimeout(desktopPollTimerRef.current);
      desktopPollTimerRef.current = null;
      void pollForApproval();
    };
    void pollForApproval();
  }

  useEffect(() => {
    if (!desktopBridge) return;
    const pollNow = () => {
      if (document.visibilityState === "visible" && desktopPollTimerRef.current) desktopPollNowRef.current?.();
    };
    window.addEventListener("focus", pollNow);
    document.addEventListener("visibilitychange", pollNow);
    return () => {
      window.removeEventListener("focus", pollNow);
      document.removeEventListener("visibilitychange", pollNow);
    };
  }, [desktopBridge]);

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
      startDesktopDeviceLoginPolling(pendingLogin);
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
        !legacyApprovalConfirmed ||
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
        setLegacyApprovalConfirmed(false);
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
    legacyApprovalConfirmed,
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

  useEffect(() => {
    if (step === "two_factor" && !useBackupCode && secondCode.length === LOGIN_CODE_LENGTH) {
      secondFactorFormRef.current?.requestSubmit();
    }
  }, [secondCode, step, useBackupCode]);

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

  async function handleSocialLogin(provider: SocialSignInProvider) {
    setError("");
    setSocialLoading(provider);
    try {
      await signInWithSocial(provider, cliMode ? window.location.href : nextPath || undefined);
    } catch (nextError) {
      setError(formatLoginError(nextError));
      setSocialLoading(null);
    }
  }

  /** Google or GitHub, opened in place by the app; the app redeems what comes back. */
  async function handleAppProviderSignIn(provider: SocialSignInProvider) {
    if (!desktopBridge) return;
    const attempt = ++appSignInAttemptRef.current;
    setError("");
    setSocialLoading(provider);
    try {
      const signedIn = await signInAppWithProvider(desktopBridge, provider);
      if (attempt !== appSignInAttemptRef.current) return;
      await setSessionFromAuthResponse(signedIn);
      router.replace(nextPath || "/app");
    } catch (nextError) {
      if (attempt !== appSignInAttemptRef.current) return;
      if (!isAbort(nextError)) {
        setError(nextError instanceof AppSignInRefused ? socialSignInFailure(nextError.code) : formatLoginError(nextError));
      }
      setSocialLoading(null);
    }
  }

  /* The browser tab may simply be closed; the app stops waiting for it here. */
  function stopWaitingForBrowser() {
    appSignInAttemptRef.current += 1;
    setSocialLoading(null);
  }

  async function handleAppleSignIn() {
    if (!desktopBridge?.signInWithApple) return;
    setError("");
    setSocialLoading("apple");
    try {
      const { nonce, hashed } = await appleSignInNonce();
      const apple = await desktopBridge.signInWithApple({ nonce: hashed });
      if (await signInWithApple({ ...apple, nonce }) === "two_factor") {
        setStep("two_factor");
        setSocialLoading(null);
        return;
      }
      router.replace(nextPath || "/app");
    } catch (nextError) {
      if (!isAbort(nextError)) setError(formatLoginError(nextError));
      setSocialLoading(null);
    }
  }

  function signInWithProvider(provider: SocialSignInProvider) {
    void (inAppSignIn ? handleAppProviderSignIn(provider) : handleSocialLogin(provider));
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
      if (await verifyOtp(email.trim(), otp.trim()) === "two_factor") {
        setStep("two_factor");
        return;
      }
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

  async function handleVerifySecondFactor(event: FormEvent) {
    event.preventDefault();
    const code = secondCode.trim();
    if (loading || !code) return;
    setError("");
    setLoading(true);
    try {
      await verifySecondFactor(code, { backup: useBackupCode, trustDevice });
      if (continueAfterSecondFactor) {
        window.location.assign(continueAfterSecondFactor);
        return;
      }
      if (!cliMode) router.push(nextPath || "/app");
    } catch (nextError) {
      setSecondCode("");
      setError(formatLoginError(nextError));
    } finally {
      setLoading(false);
    }
  }

  async function handleDeclineDevice() {
    if (!deviceCode || !userCode) return;
    setLoading(true);
    setError("");
    try {
      await declineDeviceRequest(deviceCode, userCode);
      setDeviceDeclined(true);
    } catch (nextError) {
      if (isDeviceLoginAlreadyCompletedError(nextError)) setDeviceRequest("unknown");
      else setError(userErrorMessage(nextError, "Couldn't decline the sign-in") ?? "");
    } finally {
      setLoading(false);
    }
  }

  /* Signs this browser out and comes back to the same request, to answer it as someone else. */
  async function switchAccount() {
    setLoading(true);
    const query = new URLSearchParams(searchParams);
    for (const name of ["error", "error_description", "auth_error", "two_factor"]) query.delete(name);
    await logout({ redirectTo: `/login?${query}` });
    setLoading(false);
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
      ) : deviceDeclined ? (
        <AuthHeading title="Sign-in declined">
          Nothing was shared. The {deviceClientLabel} that asked can&apos;t use this request any more. You can
          close this tab.
        </AuthHeading>
      ) : awaitingDeviceConfirmation && deviceRequest === "unknown" ? (
        <>
          <AuthHeading title="This sign-in request has ended">
            It expired or was already answered. Start a fresh sign-in from your {deviceClientLabel}.
          </AuthHeading>
          <AuthLinks><Link href="/app">Open xMatrix here</Link></AuthLinks>
        </>
      ) : awaitingDeviceConfirmation ? (
        <>
          <AuthHeading title={`Approve ${productName}?`}>
            Approve only if your {deviceClientLabel} shows this code and you started this sign-in yourself.
            Approving signs it in as you.
          </AuthHeading>
          <AuthRequest
            icon={<ShieldCheck className="size-4" />}
            title={`${productName} is asking to sign in`}
            code={userCode}
          >
            {deviceRequest && deviceRequest !== "unknown" ? <>{describeRequester(deviceRequest)}<br /></> : null}
            {signingInAs}
          </AuthRequest>
          <ApprovalChoices error={formError} loading={loading} onApprove={() => setDeviceApprovalConfirmed(true)}
            declineLabel="This is not my request" onDecline={() => void handleDeclineDevice()}
            onSwitchAccount={() => void switchAccount()} />
        </>
      ) : awaitingLegacyConfirmation ? (
        <>
          <AuthHeading title="Approve xMatrix CLI?">
            A terminal on this computer asked to sign in. Approve only if you just ran{" "}
            <code className="auth-inline-code">xmatrix login</code>. Approving signs it in as you.
          </AuthHeading>
          <AuthRequest icon={<ShieldCheck className="size-4" />} title="xMatrix CLI is asking to sign in">
            {signingInAs}
          </AuthRequest>
          <ApprovalChoices error={formError} loading={loading} onApprove={() => setLegacyApprovalConfirmed(true)}
            declineLabel="Cancel" onDecline={() => router.replace("/app")}
            onSwitchAccount={() => void switchAccount()} />
        </>
      ) : browserSignIn ? (
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
            {inAppSignIn && desktopBridge?.signInWithApple ? (
              <AuthSecondaryButton onClick={() => void handleAppleSignIn()} disabled={loading || socialLoading !== null}>
                {socialLoading === "apple" ? <Spinner /> : <AppleIcon className="size-[18px]" />}
                Continue with Apple
              </AuthSecondaryButton>
            ) : null}
            <AuthSecondaryButton onClick={() => signInWithProvider("google")} disabled={loading || socialLoading !== null}>
              {socialLoading === "google" ? <Spinner /> : <GoogleIcon className="size-[18px]" />}
              Continue with Google
            </AuthSecondaryButton>
            <AuthSecondaryButton onClick={() => signInWithProvider("github")} disabled={loading || socialLoading !== null}>
              {socialLoading === "github" ? <Spinner /> : <Image src="/app-connectors/github.svg" alt="" width={18} height={18} />}
              Continue with GitHub
            </AuthSecondaryButton>
            {inAppSignIn && desktopBridge?.client === "desktop" && (socialLoading === "google" || socialLoading === "github") ? (
              <p role="status" className="auth-hint">
                Finish signing in in your browser.{" "}
                <button type="button" className="auth-text-button" onClick={stopWaitingForBrowser}>Cancel</button>
              </p>
            ) : null}
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
              <AuthPrimaryButton type="submit" disabled={loading || socialLoading !== null}>
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
      ) : step === "two_factor" ? (
        <>
          <AuthHeading title="Two-step verification">
            {useBackupCode
              ? "Enter one of the backup codes you saved. Each works once."
              : "Enter the 6-digit code from your authenticator app."}
          </AuthHeading>
          <form ref={secondFactorFormRef} onSubmit={handleVerifySecondFactor} className="auth-stack">
            <label htmlFor="login-second-factor" className="auth-label">
              {useBackupCode ? "Backup code" : "Authentication code"}
            </label>
            <Input
              id="login-second-factor"
              type="text"
              inputMode={useBackupCode ? "text" : "numeric"}
              autoComplete="one-time-code"
              required
              autoFocus
              value={secondCode}
              onChange={(event) => {
                setSecondCode(useBackupCode
                  ? event.target.value.trim().slice(0, 32)
                  : event.target.value.replace(/\D/g, "").slice(0, LOGIN_CODE_LENGTH));
                setError("");
              }}
              placeholder={useBackupCode ? "" : "0".repeat(LOGIN_CODE_LENGTH)}
              className={useBackupCode ? "auth-input" : "auth-input auth-code-input"}
            />
            <label className="auth-check">
              <input type="checkbox" checked={trustDevice} onChange={(event) => setTrustDevice(event.target.checked)} />
              Don&apos;t ask again on this device for 30 days
            </label>
            <AuthError>{formError}</AuthError>
            <AuthPrimaryButton type="submit" disabled={loading || !secondCode}>
              {loading ? <Spinner /> : null}
              {loading ? "Signing in…" : "Verify"}
              {loading ? null : <ArrowRight className="size-4" />}
            </AuthPrimaryButton>
          </form>
          <AuthLinks>
            <button type="button" className="auth-text-button" disabled={loading} onClick={() => {
              setUseBackupCode((current) => !current);
              setSecondCode("");
              setError("");
            }}>
              {useBackupCode ? "Use your authenticator app" : "Use a backup code"}
            </button>
            <button type="button" className="auth-text-button" disabled={loading} onClick={() => {
              changeEmail();
              setSecondCode("");
              if (searchParams.get("two_factor")) {
                const query = new URLSearchParams(searchParams);
                query.delete("two_factor");
                router.replace(`/login${query.toString() ? `?${query}` : ""}`);
              }
            }}>
              Start over
            </button>
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

async function describeDeviceRequest(deviceCode: string, userCode: string): Promise<DeviceRequestDescription | "unknown"> {
  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.cli_device_describe, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode, userCode }),
  });
  if (response.status === 409) return "unknown";
  if (!response.ok) {
    const failure = await errorFromResponse(response);
    // Only the broker's own answer ends the request; a Hub still rolling out this route
    // has no description to give, and the code alone is still there to compare.
    if (failure instanceof XMatrixApiError && failure.code === "unknown_device_code") return "unknown";
    throw failure;
  }
  return (await response.json()) as DeviceRequestDescription;
}

async function declineDeviceRequest(deviceCode: string, userCode: string): Promise<void> {
  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.cli_device_decline, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode, userCode }),
  });
  if (!response.ok) throw await errorFromResponse(response);
}

/** "Asked 2 minutes ago near Berlin, DE · daniel-laptop (darwin)" */
function describeRequester(request: DeviceRequestDescription): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(request.createdAt)) / 60_000));
  const when = minutes < 1 ? "Asked just now" : minutes === 1 ? "Asked 1 minute ago" : `Asked ${minutes} minutes ago`;
  const where = request.requestedFrom ? ` near ${request.requestedFrom}` : "";
  const machine = request.hostname
    ? ` · ${request.hostname}${request.platform ? ` (${request.platform})` : ""}` : "";
  return `${when}${where}${machine}`;
}

/**
 * What a returning Google or GitHub sign-in that failed means for the person.
 * The provider's or Better Auth's code arrives in `?error=`.
 */
function socialSignInFailure(code: string): string {
  switch (code) {
    case "access_denied":
      return "Sign-in was cancelled. Choose a way to sign in when you're ready.";
    case "email_not_found":
      return "That account didn't share a verified email address. Add one there, or use a login code.";
    case "account_not_linked":
    case "unable_to_link_account":
      return "This email already has an xMatrix account. Sign in with a login code, then link the account in Settings.";
    case "state_not_found":
    case "state_mismatch":
    case "please_restart_the_process":
    case "invalid_callback_request":
      return "That sign-in took too long or was finished in another browser. Start it again.";
    default:
      return "Sign-in did not complete. Try again, or use a login code.";
  }
}

/** Approve, turn down, or answer as someone else: the choices for any device asking to sign in. */
function ApprovalChoices({ error, loading, onApprove, declineLabel, onDecline, onSwitchAccount }: {
  error: string;
  loading: boolean;
  onApprove: () => void;
  declineLabel: string;
  onDecline: () => void;
  onSwitchAccount: () => void;
}) {
  return (
    <>
      <AuthError>{error}</AuthError>
      <div className="auth-stack">
        <AuthPrimaryButton onClick={onApprove} disabled={loading}>
          {loading ? <Spinner /> : null}
          Approve
        </AuthPrimaryButton>
        <AuthSecondaryButton onClick={onDecline} disabled={loading}>{declineLabel}</AuthSecondaryButton>
      </div>
      <AuthLinks>
        <button type="button" className="auth-text-button" disabled={loading} onClick={onSwitchAccount}>
          Use a different account
        </button>
      </AuthLinks>
    </>
  );
}

function Spinner() {
  return <AnimatedIcon icon={Loader2} className="size-4 animate-spin" />;
}

/** The Hub page that hands an app its sign-in code, if `value` is one; nothing else is followed. */
function appSignInContinuation(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hub = new URL(authBaseUrl());
    return url.origin === hub.origin && url.pathname === APP_SIGN_IN_FINISH_PATH ? url.toString() : null;
  } catch {
    return null;
  }
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

  if (code === "INVALID_CODE" || code === "INVALID_BACKUP_CODE") {
    return "That code didn't match. Try the newest code from your app.";
  }

  if (code === "INVALID_TWO_FACTOR_COOKIE" || code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") {
    return "This sign-in timed out. Start over and sign in again.";
  }

  if (code === "ACCOUNT_TEMPORARILY_LOCKED") {
    return "Too many wrong codes. Wait 15 minutes, then try again.";
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
  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.cli_device_approve, {
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
