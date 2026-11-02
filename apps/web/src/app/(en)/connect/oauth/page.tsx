import type { Metadata } from "next";
import { OAuthConnectCompletion } from "@/components/connect/oauth-connect-completion";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Connect an app · xMatrix", referrer: "no-referrer" };

export default function OAuthConnectPage() {
  return <OAuthConnectCompletion />;
}
