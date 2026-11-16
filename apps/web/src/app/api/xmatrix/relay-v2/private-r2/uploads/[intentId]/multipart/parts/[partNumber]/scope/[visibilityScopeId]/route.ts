import { proxyMessageAttachmentUpload } from "@/lib/relay-v2/message-attachment-upload-proxy";

/** Streams one part of a multipart upload to the Hub. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ intentId: string; partNumber: string; visibilityScopeId: string }> },
) {
  const { intentId, partNumber, visibilityScopeId } = await context.params;
  if (!/^[1-9][0-9]{0,4}$/u.test(partNumber)) {
    return Response.json({ error: "part number is invalid", code: "invalid_request" }, { status: 400 });
  }
  return proxyMessageAttachmentUpload({ request, intentId, visibilityScopeId, partNumber: Number(partNumber) });
}
