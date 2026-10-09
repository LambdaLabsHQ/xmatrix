import { getCloudflareContext } from "@opennextjs/cloudflare";
import { clientDefectAction } from "@xmatrix/protocol";

import { webErrorReporting } from "@/lib/server-error-reporting";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_192;
const LIMITS = { name: 80, message: 300, stack: 2_000 } as const;

/**
 * A browser defect, reported like a Worker failure: under the action the person
 * was taking, with a bounded name, message and stack. Same-origin only; the
 * body carries no content by construction (src/lib/client-defect-report.ts),
 * and an action outside the closed set is not written at all.
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
  const reporting = await webErrorReporting();
  if (!reporting) return Response.json({ reference: null }, { status: 202 });
  const defect = new Error(field("message") || "(no message)");
  defect.name = field("name") || "ClientDefect";
  defect.stack = `${defect.name}: ${defect.message}\n${field("stack")}`;
  const reference = reporting.reportError(defect, { operation: `browser: ${clientDefectAction(body.action) ?? "unknown action"}` });
  getCloudflareContext().ctx.waitUntil(reporting.sendErrorReports());
  return Response.json({ reference: reference ?? null }, { status: 202 });
}
