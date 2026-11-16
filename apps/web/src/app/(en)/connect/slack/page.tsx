import type { Metadata } from "next";
import { SlackMigrationApproval } from "@/components/connect/slack-migration-approval";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Connect Slack · xMatrix", referrer: "no-referrer" };

export default function SlackMigrationApprovalPage() {
  return <SlackMigrationApproval />;
}
