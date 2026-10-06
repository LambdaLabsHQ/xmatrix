import type { Metadata } from "next";
import { SentryInstallationConfirmation } from "@/components/connect/sentry-installation-confirmation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Connect Sentry · xMatrix", referrer: "no-referrer" };

export default function SentryInstallationPage() {
  return <SentryInstallationConfirmation />;
}
