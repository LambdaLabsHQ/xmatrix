"use client";

/**
 * The operator surface shows deployment usage under one "Platform admin" rail
 * entry, which only appears for an account the Hub already reported as an
 * operator. Like every rail destination, its sections are listed beside the
 * one being read.
 */

import { BarChart3 } from "lucide-react";

import { PlatformAdminView } from "./workspace-platform-admin-view";
import { SectionedToolView } from "./tool-split";

export function PlatformAdminTabs({ token }: { token?: string }) {
  return (
    <SectionedToolView title="Platform admin" sections={[
      { key: "overview", label: "Overview", icon: BarChart3, summary: "Spaces and usage",
        description: "Every user space on this deployment, with platform-wide usage statistics.",
        content: <PlatformAdminView token={token} /> },
    ]} />
  );
}
