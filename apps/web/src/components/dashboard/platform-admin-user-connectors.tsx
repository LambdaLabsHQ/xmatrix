"use client";

import type { AdminUserConnector } from "@xmatrix/protocol";

import { AdminTable, type AdminColumn } from "./admin-table";
import { TimeCell } from "./platform-admin-cells";
import { adminTime, formatAdminCount } from "./platform-admin-overview";

const USAGE_EXPORTS: AdminColumn<AdminUserConnector>[] = ([
  ["Requests (30d)", "requestsLast30d"], ["Requests (total)", "requests"],
  ["Events (30d)", "eventDeliveriesLast30d"], ["Events (total)", "eventDeliveries"],
  ["Subscribed Channels", "subscribedChannels"],
] as const).map(([label, field]) => ({
  key: `export-${field}`, label, hidden: true,
  value: (c) => c.usage?.[field],
  render: () => null,
}));

export function AdminUserConnectors({ connectors, spaceName }: {
  connectors: AdminUserConnector[];
  spaceName: (id: string) => string;
}) {
  return <>
    <p className="mb-3 text-xs text-muted-foreground">
      Connections added by this user. Activity covers all callers in each Space, including Agents.
      Requests are recorded executions, including blocked and planned work, not provider HTTP calls.
      Events count retained standard webhook/event posts once per destination Channel; retries of the
      same post count once. Raw HTTP attempts and events without a Channel post are unavailable.
      Totals cover retained history; 30d is the last 30 days.
    </p>
    <AdminTable id="uc" label="Connectors" rows={connectors}
      rowKey={(connector) => `${connector.spaceId}:${connector.providerId}`}
      defaultSort="created" empty="No connector added."
      columns={[
        { key: "provider", label: "Connector", value: (c) => c.providerName,
          render: (c) => <span className="font-bold">{c.providerName}</span> },
        { key: "space", label: "Space", value: (c) => spaceName(c.spaceId),
          render: (c) => <span className="block truncate">{spaceName(c.spaceId)}</span> },
        { key: "status", label: "Status", value: (c) => c.status,
          render: (c) => <span className="text-xs">{c.status}</span> },
        { key: "requests", label: "Requests · 30d / total", numeric: true, noExport: true,
          value: (c) => c.usage?.requestsLast30d,
          render: (c) => c.usage ? <>
            <span>{formatAdminCount(c.usage.requestsLast30d)} / {formatAdminCount(c.usage.requests)}</span>
            <span className="block text-xs text-muted-foreground">
              {Object.entries(c.usage.byStatus).map(([status, value]) => `${value} ${status}`).join(" · ")}
            </span>
          </> : "—" },
        { key: "events", label: "Events · 30d / total", numeric: true, noExport: true,
          value: (c) => c.usage?.eventDeliveriesLast30d,
          render: (c) => c.usage
            ? `${formatAdminCount(c.usage.eventDeliveriesLast30d)} / ${formatAdminCount(c.usage.eventDeliveries)}` : "—" },
        { key: "subscriptions", label: "Subscriptions", numeric: true, value: (c) => c.usage?.subscriptions,
          render: (c) => c.usage ? <>
            {formatAdminCount(c.usage.subscriptions)}
            <span className="block text-xs text-muted-foreground">{c.usage.subscribedChannels} subscribed Channels</span>
          </> : "—" },
        { key: "lastRequest", label: "Last request", numeric: true, value: (c) => adminTime(c.usage?.lastRequestAt),
          render: (c) => c.usage ? <TimeCell value={c.usage.lastRequestAt} fallback="Never" /> : "—" },
        { key: "lastEvent", label: "Last event", numeric: true, value: (c) => adminTime(c.usage?.lastEventAt),
          render: (c) => c.usage ? <TimeCell value={c.usage.lastEventAt} fallback="Never" /> : "—" },
        { key: "created", label: "Added", numeric: true, value: (c) => adminTime(c.createdAt),
          render: (c) => <TimeCell value={c.createdAt} /> },
        ...USAGE_EXPORTS,
        ...(["queued", "completed", "failed", "blocked", "planned"] as const).map((status) => ({
          key: `export-${status}`, label: `Requests ${status} (total)`, hidden: true,
          value: (c: AdminUserConnector) => c.usage?.byStatus[status], render: () => null,
        })),
      ]} />
  </>;
}
