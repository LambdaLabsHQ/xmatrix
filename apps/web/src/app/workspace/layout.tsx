import { AppPreparationGate } from "@/components/app-preparation/app-preparation-gate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function WorkspaceRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppPreparationGate>{children}</AppPreparationGate>;
}
