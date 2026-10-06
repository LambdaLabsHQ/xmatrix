import {
  RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER,
  RELAY_V2_BLOB_UPLOAD_PREFIX,
} from "@xmatrix/protocol/relay-v2/message-attachment";
import { withRoute } from "@xmatrix/protocol";
import { getXMatrixHubUrl } from "@/lib/xmatrix";
import { getProxyAuthorization } from "@/lib/xmatrix-proxy";
import {
  ProxySessionRefreshError,
  classifyProxyFailure,
  logProxyFailure,
} from "@/lib/xmatrix-proxy-failure";

/** Stream one browser upload to the exact scoped Hub authority selected by its intent. */
export async function proxyMessageAttachmentUpload(input: {
  request: Request;
  intentId: string;
  visibilityScopeId?: string;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
  const uploadPath = `${RELAY_V2_BLOB_UPLOAD_PREFIX}/${encodeURIComponent(input.intentId)}` +
    (input.visibilityScopeId === undefined
      ? ""
      : `/scope/${encodeURIComponent(input.visibilityScopeId)}`);

  const startedAt = Date.now();
  try {
    const authorization = await getProxyAuthorization(
      input.request.headers.get("authorization") || undefined,
    ).catch((cause) => { throw new ProxySessionRefreshError(cause); });
    const response = await fetch(withRoute(getXMatrixHubUrl(), uploadPath), {
      method: "PUT",
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(input.request.headers.get("content-type")
          ? { "content-type": input.request.headers.get("content-type") || "" }
          : {}),
        ...(input.request.headers.get("content-length")
          ? { "content-length": input.request.headers.get("content-length") || "" }
          : {}),
        ...(input.request.headers.get(RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER)
          ? {
              [RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER]:
                input.request.headers.get(RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER) || "",
            }
          : {}),
      },
      body: input.request.body,
      cache: "no-store",
      signal: controller.signal,
      ...(input.request.body ? { duplex: "half" } : {}),
    } as RequestInit & { duplex?: "half" });

    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
        "cache-control": response.headers.get("cache-control") || "no-store",
      },
    });
  } catch (cause) {
    const failure = classifyProxyFailure({ cause, timedOut: controller.signal.aborted });
    logProxyFailure({
      route: input.request.url,
      method: input.request.method,
      elapsedMs: Date.now() - startedAt,
      failure,
      cause,
    });
    return Response.json({ error: failure.error, reason: failure.reason }, { status: failure.status });
  } finally {
    clearTimeout(timeout);
  }
}
