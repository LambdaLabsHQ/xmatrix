import { redirect } from "next/navigation";

export default async function LegacyChannelRoutePage({
  params,
}: {
  params: Promise<{ spaceId: string; channelId: string }>;
}) {
  const { spaceId, channelId } = await params;

  redirect(
    `/app/${encodeURIComponent(spaceId)}/channels/${encodeURIComponent(channelId)}`
  );
}
