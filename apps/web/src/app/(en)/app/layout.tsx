import { AppPreparationGate } from "@/components/app-preparation/app-preparation-gate";
import { HubPreconnect } from "@/components/app-preparation/hub-preconnect";

export default function AppRouteLayout(props: { children: React.ReactNode }) {
  return (
    <>
      <HubPreconnect />
      <AppPreparationGate>{props.children}</AppPreparationGate>
    </>
  );
}
