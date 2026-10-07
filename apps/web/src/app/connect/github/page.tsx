import type { Metadata } from "next";
import { GitHubConnectReturn } from "@/components/connect/github-connect-return";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Connect GitHub · xMatrix", referrer: "no-referrer" };

export default function GitHubConnectPage() {
  return <GitHubConnectReturn />;
}
