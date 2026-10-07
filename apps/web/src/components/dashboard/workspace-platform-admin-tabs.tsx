"use client";

/**
 * The operator surface shows deployment usage under one "Platform admin" rail
 * entry, which only appears for an account the Hub already reported as an
 * operator. Like every rail destination, its sections are listed beside the
 * one being read. Everything here is metadata only, and every read is audited.
 */

import { BarChart3, Building, ScrollText, Users } from "lucide-react";

import { PlatformAdminView } from "./workspace-platform-admin-view";
import { PlatformAdminAudit, PlatformAdminSpaces } from "./platform-admin-lists";
import { PlatformAdminUsers } from "./platform-admin-users";
import { SectionedToolView } from "./tool-split";

export function PlatformAdminTabs({ token }: { token?: string }) {
  return (
    <div className="app-admin-view flex min-h-0 min-w-0 flex-1">
      <SectionedToolView title="Platform admin" showContext={false} sections={[
        { key: "overview", label: "Overview", icon: BarChart3, summary: "Usage across the platform",
          content: <PlatformAdminView token={token} /> },
        { key: "users", wide: true, label: "Users", icon: Users, summary: "Every registered user",
          content: <PlatformAdminUsers token={token} /> },
        { key: "spaces", wide: true, label: "Spaces", icon: Building, summary: "Every Space and its usage",
          content: <PlatformAdminSpaces token={token} /> },
        { key: "audit", wide: true, label: "Audit", icon: ScrollText, summary: "What operators read and did",
          description: "Operator access to metadata is recorded here.",
          content: <PlatformAdminAudit token={token} /> },
      ]} />
    </div>
  );
}
