import { AppPreparationGate } from "@/components/app-preparation/app-preparation-gate";
import { HubPreconnect } from "@/components/app-preparation/hub-preconnect";

// `/app` opens here (middleware.ts). Nothing on this route reads the request:
// the gate, the startup frame and the shell are client components, and the
// signed-out redirect happens in the browser. So the page is prerendered once
// per build (○) and served as that file, the same bytes for every visitor.
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
