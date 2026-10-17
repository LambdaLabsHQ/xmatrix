import type { Metadata } from "next";
import { SetupLinkReturn } from "@/components/connect/setup-link-return";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Continue setup · xMatrix", referrer: "no-referrer" };

export default function ContinueSetupPage() {
  return <SetupLinkReturn />;
}
