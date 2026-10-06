import { AppPreparationGate } from "@/components/app-preparation/app-preparation-gate";

export default function AppRouteLayout(props: { children: React.ReactNode }) {
  return <AppPreparationGate>{props.children}</AppPreparationGate>;
}
