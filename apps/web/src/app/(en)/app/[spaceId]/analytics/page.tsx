import { redirect } from "next/navigation";

export default async function AnalyticsRoutePage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  redirect(`/app/${encodeURIComponent(spaceId)}/more`);
}
