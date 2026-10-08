import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_192;
const LIMITS = { action: 120, name: 80, message: 300, stack: 2_000 } as const;

/**
 * A browser defect, reported like a Worker failure: under the action the person
 * was taking, with a bounded name, message and stack. Same-origin only; the
 * body carries no content by construction (src/lib/client-defect-report.ts).
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return new Response(null, { status: 400 });
    body = parsed as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400 });
  }
  const field = (key: keyof typeof LIMITS) => typeof body[key] === "string"
    ? (body[key] as string).slice(0, LIMITS[key]) : "";
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return Response.json({ reference: null }, { status: 202 });
  const defect = new Error(field("message") || "(no message)");
  defect.name = field("name") || "ClientDefect";
  defect.stack = `${defect.name}: ${defect.message}\n${field("stack")}`;
  const { reportError, sendErrorReports } = await import("@xmatrix/protocol/error-reporting");
  const reference = reportError(defect, { operation: `browser: ${field("action") || "unknown action"}` });
  getCloudflareContext().ctx.waitUntil(sendErrorReports());
  return Response.json({ reference: reference ?? null }, { status: 202 });
}
