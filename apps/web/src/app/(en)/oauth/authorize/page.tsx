import type { Metadata } from "next";
import { OAuthAuthorizeHandoff } from "@/components/oauth/oauth-authorize-handoff";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in · xMatrix", referrer: "no-referrer" };

export default function OAuthAuthorizePage() {
  return <OAuthAuthorizeHandoff />;
}
