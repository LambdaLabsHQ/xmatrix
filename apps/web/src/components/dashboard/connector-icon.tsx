"use client";

import { APP_CONNECTOR_PROVIDER_MANIFESTS, type SerializedAppConnectorConnection } from "@xmatrix/protocol";
import { Bug, GitPullRequest, ListTodo, MessageSquare, PlugZap, Rocket, Siren, Webhook } from "lucide-react";
import Image from "next/image";

import type { AppConnectorManifest } from "@/lib/app-connectors";
import { cn } from "@/lib/utils";

// A conversation's subscriptions show these too, so they live apart from the
// Apps and Machines views, which load only when opened.

export function connectorConnectionStatusLabel(status: SerializedAppConnectorConnection["status"]): string {
  if (status === "configured") return "Connected";
  if (status === "error") return "Needs attention";
  return "Disconnected";
}

const CONNECTOR_KIND_ICONS: Partial<Record<AppConnectorManifest["kind"], React.ComponentType<{ className?: string }>>> = {
  "code-host": GitPullRequest,
  webhook: Webhook,
  observability: Bug,
  "issue-tracker": ListTodo,
  incident: Siren,
  chat: MessageSquare,
  deploy: Rocket,
  ci: Rocket,
  gateway: PlugZap,
};

// The same checked-in vendor assets identify Apps and their message authors.
// Stable component identities avoid remounting subscription controls on refresh.
const CONNECTOR_VENDOR_ICONS = new Map(APP_CONNECTOR_PROVIDER_MANIFESTS.map(provider => [provider.id,
  function ConnectorVendorIcon({ className }: { className?: string }) {
    return <Image src={`/app-connectors/${provider.id}.svg`} alt="" width={24} height={24}
      unoptimized className={cn("shrink-0 object-contain", className)} />;
  }]));

export function connectorIcon(connector: AppConnectorManifest): React.ComponentType<{ className?: string }> {
  return CONNECTOR_VENDOR_ICONS.get(connector.id) ?? CONNECTOR_KIND_ICONS[connector.kind] ?? PlugZap;
}
