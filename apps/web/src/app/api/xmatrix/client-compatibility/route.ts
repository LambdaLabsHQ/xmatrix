import { NextResponse } from "next/server";
import {
  CLIENT_COMPATIBILITY_HEADERS,
  CLIENT_COMPATIBILITY_PATH,
  clientCompatibilityHeaders,
  evaluateClientCompatibility,
  parseClientCompatibilityIdentity,
} from "@xmatrix/protocol";
import { getXMatrixHubUrl } from "@/lib/xmatrix";
import {
  APP_COMPATIBILITY_COOKIE,
  serializeAppCompatibilityCookie,
} from "@/lib/client-compatibility-server";
import { FIRST_PARTY_COOKIE_OPTIONS } from "@/lib/native-session";

const MAX_RESPONSE_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const identity = parseClientCompatibilityIdentity(await request.json().catch(() => null));
  if (!identity || identity.component !== "app") {
    return NextResponse.json(evaluateClientCompatibility(identity), {
      status: 426,
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (process.env.NEXT_PUBLIC_XMATRIX_E2E_COMPATIBILITY_FIXTURE === "1") {
    return NextResponse.json(evaluateClientCompatibility(identity), {
      headers: { "cache-control": "private, no-store" },
    });
  }
  try {
    const upstream = await fetch(new URL(CLIENT_COMPATIBILITY_PATH, getXMatrixHubUrl()), {
      headers: clientCompatibilityHeaders(identity),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_RESPONSE_BYTES) throw new Error("Compatibility response is oversized");
    const response = new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "private, no-store",
        vary: Object.values(CLIENT_COMPATIBILITY_HEADERS).join(", "),
      },
    });
    if (upstream.ok) {
      response.cookies.set(
        APP_COMPATIBILITY_COOKIE,
        serializeAppCompatibilityCookie(identity),
        FIRST_PARTY_COOKIE_OPTIONS,
      );
    } else {
      response.cookies.set(APP_COMPATIBILITY_COOKIE, "", {
        ...FIRST_PARTY_COOKIE_OPTIONS,
        maxAge: 0,
      });
    }
    return response;
  } catch {
    return NextResponse.json({
      compatible: false,
      code: "compatibility_check_unavailable",
      error: "The xMatrix compatibility service is unavailable.",
      retryable: true,
    }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
}
