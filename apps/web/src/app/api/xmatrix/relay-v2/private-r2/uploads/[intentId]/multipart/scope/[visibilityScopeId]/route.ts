import { relayV2BlobUploadPaths } from "@xmatrix/protocol/relay-v2/message-attachment";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

/** Starts, or resumes, the multipart upload of a body too large for one request. */
export const POST = hubRouteHandler(
  "POST",
  (intentId, visibilityScopeId) => relayV2BlobUploadPaths(intentId, visibilityScopeId).multipart,
  ["intentId", "visibilityScopeId"],
);
