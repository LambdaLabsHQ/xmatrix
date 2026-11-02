import WorkspaceAppShell from "@/components/dashboard/workspace-app-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function SpaceRouteLayout(props: { children: React.ReactNode }) {
  return <WorkspaceAppShell>{props.children}</WorkspaceAppShell>;
}
