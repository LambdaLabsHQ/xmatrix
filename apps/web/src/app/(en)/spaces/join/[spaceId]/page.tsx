import { SpaceJoinClient } from "./join-client";

export default async function SpaceJoinPage({ params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return <SpaceJoinClient spaceId={spaceId} />;
}
