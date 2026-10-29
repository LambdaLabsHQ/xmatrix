import { AppPreparationGate } from "@/components/app-preparation/app-preparation-gate";
import { HubPreconnect } from "@/components/app-preparation/hub-preconnect";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function WorkspaceRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <HubPreconnect />
      <AppPreparationGate>{children}</AppPreparationGate>
    </>
  );
}
