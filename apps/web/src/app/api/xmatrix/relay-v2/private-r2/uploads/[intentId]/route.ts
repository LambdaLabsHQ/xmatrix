import { proxyMessageAttachmentUpload } from "@/lib/relay-v2/message-attachment-upload-proxy";

export async function PUT(
  request: Request,
  context: { params: Promise<{ intentId: string }> },
) {
  const { intentId } = await context.params;
  return proxyMessageAttachmentUpload({ request, intentId });
}
