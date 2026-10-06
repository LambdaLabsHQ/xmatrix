import { NextResponse } from "next/server";
import { HUB_ROUTES, type AuthResponse, withRoute } from "@xmatrix/protocol";
import { getXMatrixHubUrl } from "@/lib/xmatrix";
import {
  NATIVE_ACCESS_COOKIE,
  NATIVE_PROVIDER_COOKIE,
  NATIVE_REFRESH_COOKIE,
  clearNativeSessionCookies,
  isCompleteAuthResponse,
  isTransientHubStatus,
  refreshNativeSession,
  setNativeSessionCookies,
} from "@/lib/native-session";

export async function GET(request: Request) {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const accessToken = cookies.get(NATIVE_ACCESS_COOKIE);
  const refreshToken = cookies.get(NATIVE_REFRESH_COOKIE);
  const authProvider = normalizeAuthProvider(cookies.get(NATIVE_PROVIDER_COOKIE));

  if (!accessToken || !refreshToken) {
    return NextResponse.json({ session: null });
  }

  const current = await loadUserFromAccessToken(accessToken);
  if (current) {
    return NextResponse.json({
      session: sessionResponse({
        token: accessToken,
        refreshToken,
        authProvider,
        user: current.user,
        hubUrl: current.hubUrl,
        relayUrl: current.relayUrl,
      }),
    });
  }

  const refreshed = await refreshNativeSession(refreshToken);
  const response = NextResponse.json({ session: refreshed ? sessionResponse(refreshed) : null });
  if (refreshed) setNativeSessionCookies(response.cookies, refreshed);
  else clearNativeSessionCookies(response.cookies);
  return response;
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as Partial<AuthResponse>;
  if (!isCompleteAuthResponse(payload)) {
    return NextResponse.json({ error: "Native session payload is incomplete" }, { status: 400 });
  }

  const response = NextResponse.json({ session: sessionResponse(payload) });
  setNativeSessionCookies(response.cookies, payload);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  clearNativeSessionCookies(response.cookies);
  return response;
}

function sessionResponse(payload: AuthResponse) {
  return {
    token: payload.token,
    refreshToken: payload.refreshToken,
    authProvider: payload.authProvider,
    user: payload.user,
    hubUrl: payload.hubUrl,
    relayUrl: payload.relayUrl,
  };
}

async function loadUserFromAccessToken(token: string): Promise<Omit<AuthResponse, "token" | "refreshToken" | "authProvider"> | null> {
  let response: Response;
  try {
    response = await fetch(withRoute(getXMatrixHubUrl(), HUB_ROUTES.me), {
      headers: {
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
  } catch {
    throw new Error("Native session verification is temporarily unavailable");
  }

  if (!response.ok) {
    if (isTransientHubStatus(response.status)) {
      throw new Error("Native session verification is temporarily unavailable");
    }
    return null;
  }

  const payload = (await response.json().catch(() => null)) as
    | {
        user?: AuthResponse["user"];
        hubUrl?: string;
        relayUrl?: string;
      }
    | null;

  if (!payload?.user || !payload.hubUrl || !payload.relayUrl) {
    return null;
  }

  return {
    user: payload.user,
    hubUrl: payload.hubUrl,
    relayUrl: payload.relayUrl,
  };
}

function parseCookieHeader(header: string | null) {
  const cookies = new Map<string, string>();
  for (const part of (header || "").split(";")) {
    const [rawName, ...rawValue] = part.split("=");
    const name = rawName?.trim();
    if (!name) continue;
    cookies.set(name, decodeURIComponent(rawValue.join("=").trim()));
  }
  return cookies;
}

function normalizeAuthProvider(value: string | undefined): AuthResponse["authProvider"] {
  if (value === "better-auth" || value === "supabase" || value === "mock") {
    return value;
  }
  return undefined;
}
