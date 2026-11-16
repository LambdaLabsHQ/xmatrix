import { relayV2BlobUploadPaths } from "@xmatrix/protocol/relay-v2/message-attachment";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

/** Publishes a multipart upload's verified parts as the immutable object. */
export const POST = hubRouteHandler(
  "POST",
  (intentId, visibilityScopeId) => relayV2BlobUploadPaths(intentId, visibilityScopeId).complete,
  ["intentId", "visibilityScopeId"],
);
