import type { Metadata } from "next";
import { OAuthConsent } from "@/components/oauth/oauth-consent";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Allow access · xMatrix", referrer: "no-referrer" };

export default function OAuthConsentPage() {
  return <OAuthConsent />;
}
