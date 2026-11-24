import { getCloudflareContext } from "@opennextjs/cloudflare";
import { parseClientDefectReport } from "@xmatrix/protocol";

import { webErrorReporting } from "@/lib/server-error-reporting";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_192;

/**
 * A browser defect, reported like a Worker failure: under the action the person
 * was taking, with the error's class, its code and its stack's code locations
 * (protocol `parseClientDefectReport`). Same-origin only; a body with any other
 * field, a message among them, or an action outside the closed set is not
 * written at all.
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  let report: ReturnType<typeof parseClientDefectReport>;
  try {
    report = parseClientDefectReport(JSON.parse(text));
  } catch {
    report = undefined;
  }
  if (!report) return new Response(null, { status: 400 });
  const reporting = await webErrorReporting();
  if (!reporting) return Response.json({ reference: null }, { status: 202 });
  const defect = Object.assign(new Error(report.code ?? ""), report.code ? { code: report.code } : {});
  defect.name = report.name;
  defect.stack = `${defect.name}: ${defect.message}\n${report.stack}`;
  const reference = reporting.reportError(defect, { operation: `browser: ${report.action}` });
  getCloudflareContext().ctx.waitUntil(reporting.sendErrorReports());
  return Response.json({ reference: reference ?? null }, { status: 202 });
}
