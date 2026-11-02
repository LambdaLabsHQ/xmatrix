import type { Metadata } from "next";
import { UpgradeRequiredScreen } from "@/components/client-compatibility/upgrade-required-screen";

export const metadata: Metadata = {
  title: "Update required — xMatrix",
  robots: { index: false, follow: false },
};

export default function UpgradeRequiredPage() {
  return <UpgradeRequiredScreen />;
}
