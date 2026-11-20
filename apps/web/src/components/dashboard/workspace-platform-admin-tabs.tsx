"use client";

/**
 * The operator surface shows deployment usage under one "Platform admin" rail
 * entry, which only appears for an account the Hub already reported as an
 * operator. Like every rail destination, its sections are listed beside the
 * one being read. Everything here is metadata only, and every read is audited.
 */

import { Activity, BarChart3, Building, CreditCard, ScrollText, Users } from "lucide-react";

import { PlatformAdminView } from "./workspace-platform-admin-view";
import { PlatformAdminAudit, PlatformAdminSpaces } from "./platform-admin-lists";
import { PlatformAdminUsers } from "./platform-admin-users";
import { PlatformAdminOperations } from "./platform-admin-operations";
import { PlatformAdminBilling } from "./platform-admin-billing";
import { useAdminParam } from "./platform-admin-data";
import { SectionedToolView } from "./tool-split";
import { useViewSelection } from "./url-query-state";

export function PlatformAdminTabs({ token }: { token?: string }) {
  // A user's record replaces the section's own Back with one to its list.
  const [section] = useViewSelection("admin");
  const [openUserId] = useAdminParam("user");
  return (
    <div className="app-admin-view flex min-h-0 min-w-0 flex-1"
      data-record-open={section === "users" && openUserId ? "" : undefined}>
      <SectionedToolView title="Platform admin" view="admin" sections={[
        { key: "overview", label: "Overview", icon: BarChart3, summary: "Usage across the platform",
          content: <PlatformAdminView token={token} /> },
        { key: "users", wide: true, label: "Users", icon: Users, summary: "Every registered user",
          content: <PlatformAdminUsers token={token} /> },
        { key: "spaces", wide: true, label: "Spaces", icon: Building, summary: "Every Space and its usage",
          content: <PlatformAdminSpaces token={token} /> },
        { key: "operations", wide: true, label: "Operations", icon: Activity, summary: "Machines, Runs, delivery",
          content: <PlatformAdminOperations token={token} /> },
        { key: "billing", wide: true, label: "Billing", icon: CreditCard, summary: "Subscriptions and paid calls",
          content: <PlatformAdminBilling token={token} /> },
        { key: "audit", wide: true, label: "Audit", icon: ScrollText, summary: "What operators read and did",
          description: "Operator access to metadata is recorded here.",
          content: <PlatformAdminAudit token={token} /> },
      ]} />
    </div>
  );
}
