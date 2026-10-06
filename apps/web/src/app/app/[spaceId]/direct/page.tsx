import { redirect } from "next/navigation";

export default async function DirectRoutePage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  redirect(`/app/${encodeURIComponent(spaceId)}/channels`);
}
