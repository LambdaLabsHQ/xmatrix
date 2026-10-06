import { redirect } from "next/navigation";

/**
 * `/roles` was the Agents screen's address while Agents could be given Roles.
 * Published iOS builds and bookmarks still open it, so it lands on
 * Agents with the same query (`?item=` names the open agent). Remove it with
 * the `roles` entry in `LEGACY_VIEW_SEGMENTS`.
 */
export default async function LegacyRolesRoutePage({
  params,
  searchParams,
}: {
  params: Promise<{ spaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { spaceId } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  const search = query.toString();
  redirect(`/app/${encodeURIComponent(spaceId)}/agents${search ? `?${search}` : ""}`);
}
