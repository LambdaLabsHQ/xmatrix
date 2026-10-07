"use client";

/**
 * The platform-admin lists that are read as a table: Spaces and the admin
 * audit trail. Each is one `AdminTable` over a metadata-only Hub read.
 */

import type { AdminAuditEvent, AdminSpaceSummary } from "@xmatrix/protocol";

import { Badge } from "@/components/ui/badge";
import { AdminTable, type AdminColumn } from "./admin-table";
import { useAdminAudit, usePlatformOverview } from "./platform-admin-data";
import { adminTime, formatAdminAge, formatAdminCount } from "./platform-admin-overview";
import { AdminQueryView } from "./workspace-platform-admin-view";

function age(value: string | undefined): string {
  return formatAdminAge(value, Date.now()) || "—";
}

const SPACE_COLUMNS: AdminColumn<AdminSpaceSummary>[] = [
  { key: "name", label: "Space", value: (space) => space.name,
    render: (space) => <span className="block truncate font-bold">{space.name}</span> },
  { key: "owner", label: "Owner", value: (space) => space.ownerEmail || space.ownerUserId,
    render: (space) => <span className="block truncate text-xs text-muted-foreground">{space.ownerEmail || space.ownerUserId}</span> },
  { key: "members", label: "Members", numeric: true, value: (space) => space.members,
    render: (space) => formatAdminCount(space.members) },
  { key: "channels", label: "Channels", numeric: true, value: (space) => space.activeChannels,
    render: (space) => formatAdminCount(space.activeChannels) },
  { key: "agents", label: "Agents", numeric: true, value: (space) => space.agentRegistrations,
    render: (space) => formatAdminCount(space.agentRegistrations) },
  { key: "messages", label: "Messages", numeric: true, value: (space) => space.messages,
    render: (space) => formatAdminCount(space.messages) },
  { key: "messages7d", label: "7d", numeric: true, value: (space) => space.messagesLast7d,
    render: (space) => formatAdminCount(space.messagesLast7d) },
  { key: "created", label: "Created", numeric: true, value: (space) => adminTime(space.createdAt),
    render: (space) => <span className="whitespace-nowrap text-xs text-muted-foreground">{age(space.createdAt)}</span> },
  { key: "active", label: "Last activity", numeric: true,
    value: (space) => adminTime(space.lastMessageAt || space.createdAt),
    render: (space) => <span className="whitespace-nowrap text-xs text-muted-foreground">{age(space.lastMessageAt || space.createdAt)}</span> },
];

export function PlatformAdminSpaces({ token }: { token?: string }) {
  return (
    <AdminQueryView query={usePlatformOverview(token)} generatedAt={(overview) => overview.generatedAt}
      emptyTitle="No Spaces yet" emptyBody="Spaces appear here once someone creates one.">
      {(overview) => (
        <AdminTable
          id="s"
          label="Spaces"
          rows={overview.spaces}
          columns={SPACE_COLUMNS}
          rowKey={(space) => space.id}
          search={(space) => [space.id, space.name, space.ownerEmail, space.ownerUserId].filter(Boolean).join(" ")}
          searchPlaceholder="Space, owner, id"
          defaultSort="active"
          empty="No Space matches this search."
          note={overview.truncated.spaces ? "Showing the most recently created Spaces only; the Hub caps one read." : undefined}
        />
      )}
    </AdminQueryView>
  );
}

const ACTION_LABELS: Record<AdminAuditEvent["action"], string> = {
  "overview.read": "Read the overview",
  "user.read": "Opened a user",
  "audit.read": "Read the audit trail",
  "handles.backfill": "Backfilled handles",
  "agent-senders.repair": "Repaired Agent senders",
};

const AUDIT_COLUMNS: AdminColumn<AdminAuditEvent>[] = [
  { key: "at", label: "When", value: (event) => adminTime(event.createdAt),
    render: (event) => <span className="whitespace-nowrap text-xs" title={event.createdAt}>{age(event.createdAt)}</span> },
  { key: "actor", label: "Operator", value: (event) => event.actorEmail || event.actorUserId,
    render: (event) => <span className="block truncate">{event.actorEmail || event.actorUserId}</span> },
  { key: "action", label: "Action", value: (event) => event.action,
    render: (event) => <Badge variant="secondary">{ACTION_LABELS[event.action] ?? event.action}</Badge> },
  { key: "target", label: "Target", value: (event) => event.targetId,
    render: (event) => event.targetId
      ? <span className="block truncate font-mono text-xs">{event.targetKind}:{event.targetId}</span>
      : <span className="text-muted-foreground">—</span> },
];

export function PlatformAdminAudit({ token }: { token?: string }) {
  return (
    <AdminQueryView query={useAdminAudit(token)}
      emptyTitle="Nothing recorded yet" emptyBody="Operator reads are recorded here as they happen.">
      {(events) => (
        <AdminTable
          id="a"
          label="Audit trail"
          rows={events}
          columns={AUDIT_COLUMNS}
          rowKey={(event) => event.eventId}
          search={(event) => [event.actorEmail, event.actorUserId, event.action, event.targetId].filter(Boolean).join(" ")}
          searchPlaceholder="Operator, action, target"
          defaultSort="at"
          empty="No event matches this search."
        />
      )}
    </AdminQueryView>
  );
}
