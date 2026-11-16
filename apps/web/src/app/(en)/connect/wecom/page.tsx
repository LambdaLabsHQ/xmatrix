import type { Metadata } from "next";
import { WeComInstallationConfirmation } from "@/components/connect/wecom-installation-confirmation";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connect WeCom · xMatrix", referrer: "no-referrer" };
export default function WeComInstallationPage() { return <WeComInstallationConfirmation />; }
