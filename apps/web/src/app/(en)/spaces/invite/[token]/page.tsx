import { SpaceInviteClient } from "./invite-client";

export default async function SpaceInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SpaceInviteClient token={token} />;
}
