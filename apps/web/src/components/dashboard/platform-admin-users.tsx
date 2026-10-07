"use client";

/**
 * Registered users, and one user's detail opened from the list (`?user=<id>`).
 *
 * The detail is metadata only — identity, sign-in methods, sessions by time,
 * Spaces and roles, Agents, Machines, connectors, Run and message counts. The
 * Hub records each open in the admin audit trail.
 */

import type { AdminUserDetail, AdminUserSummary } from "@xmatrix/protocol";
import { ChevronLeft } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { AdminTable, type AdminColumn } from "./admin-table";
import { useAdminParam, useAdminUserDetail, usePlatformOverview } from "./platform-admin-data";
import {
  adminTime,
  adminUserLabel,
  formatAdminAge,
  formatAdminCount,
} from "./platform-admin-overview";
import { ToolDetailSection, ToolFact, ToolFacts } from "./tool-split";
import { AdminDailyBars, AdminQueryView, AdminStatGrid } from "./workspace-platform-admin-view";

function age(value: string | undefined, fallback = "—"): string {
  return formatAdminAge(value, Date.now()) || fallback;
}

/** A time cell: one line, the exact UTC time on hover. */
function TimeCell({ value, fallback }: { value: string | undefined; fallback?: string }) {
  return <span className="whitespace-nowrap text-xs text-muted-foreground" title={value}>{age(value, fallback)}</span>;
}

function utc(value: string | undefined): string {
  return value ? `${value.slice(0, 16).replace("T", " ")} UTC` : "—";
}

const USER_COLUMNS: AdminColumn<AdminUserSummary>[] = [
  {
    key: "user", label: "User", value: (user) => adminUserLabel(user),
    render: (user) => (
      <>
        <span className="block truncate font-bold">{adminUserLabel(user)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[user.name ? user.email : undefined, user.handle ? `@${user.handle}` : undefined]
            .filter(Boolean).join(" · ") || user.userId}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {[user.providers?.join(", "), user.emailVerified === false ? "email unverified" : undefined]
            .filter(Boolean).join(" · ")}
        </span>
      </>
    ),
  },
  // Shown under the name; its own column only in the CSV.
  { key: "email", label: "Email", value: (user) => user.email, hidden: true, render: () => null },
  {
    key: "providers", label: "Sign-in", hidden: true, value: (user) => user.providers?.join(" "),
    render: (user) => <span className="text-xs text-muted-foreground">{user.providers?.join(", ") || "—"}</span>,
  },
  {
    key: "registered", label: "Registered", numeric: true, value: (user) => adminTime(user.registeredAt),
    render: (user) => <TimeCell value={user.registeredAt} />,
  },
  {
    key: "lastAccess", label: "Last access", numeric: true, value: (user) => adminTime(user.lastSessionAt),
    render: (user) => <TimeCell value={user.lastSessionAt} fallback="Never" />,
  },
  {
    key: "sessions", label: "Sessions", numeric: true, value: (user) => user.activeSessions ?? 0,
    render: (user) => `${formatAdminCount(user.activeSessions ?? 0)} / ${formatAdminCount(user.sessionCount ?? 0)}`,
  },
  {
    key: "verified", label: "Verified", hidden: true, value: (user) => (user.emailVerified ? "yes" : "no"),
    render: (user) => <span className="text-xs">{user.emailVerified === undefined ? "—" : user.emailVerified ? "Yes" : "No"}</span>,
  },
  { key: "spaces", label: "Spaces", numeric: true, value: (user) => user.spaces, render: (user) => formatAdminCount(user.spaces) },
  { key: "agents", label: "Agents", numeric: true, value: (user) => user.agentRegistrations, render: (user) => formatAdminCount(user.agentRegistrations) },
  { key: "machines", label: "Machines", numeric: true, value: (user) => user.machines, render: (user) => formatAdminCount(user.machines) },
  { key: "messages", label: "Messages", numeric: true, value: (user) => user.messages, render: (user) => formatAdminCount(user.messages) },
  {
    key: "lastMessage", label: "Last message", hidden: true, numeric: true, value: (user) => adminTime(user.lastMessageAt),
    render: (user) => <TimeCell value={user.lastMessageAt} />,
  },
];

function userSearchText(user: AdminUserSummary): string {
  return [user.userId, user.name, user.handle, user.email, ...(user.providers ?? [])].filter(Boolean).join(" ");
}

export function PlatformAdminUsers({ token }: { token?: string }) {
  const [openUserId, setOpenUserId] = useAdminParam("user");
  if (openUserId) {
    return <AdminUserDetailView token={token} userId={openUserId} onBack={() => setOpenUserId("", { push: true })} />;
  }
  return <UsersList token={token} onOpen={(userId) => setOpenUserId(userId, { push: true })} />;
}

function UsersList({ token, onOpen }: { token?: string; onOpen: (userId: string) => void }) {
  return (
    <AdminQueryView query={usePlatformOverview(token)} generatedAt={(overview) => overview.generatedAt}
      emptyTitle="No users yet" emptyBody="Registered users appear here once someone signs up.">
      {(overview) => (
        <AdminTable
          id="u"
          label="Registered users"
          rows={overview.users}
          columns={USER_COLUMNS}
          rowKey={(user) => user.userId}
          search={userSearchText}
          searchPlaceholder="Name, email, handle, id"
          defaultSort="lastAccess"
          onRowClick={(user) => onOpen(user.userId)}
          empty="No user matches this search."
          note={overview.truncated.users
            ? "Showing the most recently registered users only; the Hub caps one read."
            : undefined}
        />
      )}
    </AdminQueryView>
  );
}

function AdminUserDetailView({ token, userId, onBack }: { token?: string; userId: string; onBack: () => void }) {
  return (
    <AdminQueryView query={useAdminUserDetail(token, userId)} generatedAt={(detail) => detail.generatedAt}
      lead={<button type="button" onClick={onBack}
        className="-ml-1 mr-auto flex items-center gap-0.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Users
      </button>}
      emptyTitle="User not found" emptyBody="No registered user or Space member has this id.">
      {(detail) => <div className="space-y-7"><UserDetailBody detail={detail} /></div>}
    </AdminQueryView>
  );
}

function UserDetailBody({ detail }: { detail: AdminUserDetail }) {
  const { user } = detail;
  const spaceNames = new Map(detail.spaces.map((space) => [space.spaceId, space.name]));
  const spaceName = (spaceId: string) => spaceNames.get(spaceId) ?? spaceId;
  return (
    <>
      <header>
        <h3 className="break-words text-2xl font-black">{adminUserLabel(user)}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {[user.email, user.handle ? `@${user.handle}` : undefined].filter(Boolean).join(" · ")}
        </p>
        {detail.truncated.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Lists cut at their bound: {detail.truncated.join(", ")}.
          </p>
        )}
      </header>

      <ToolDetailSection title="Account">
        <ToolFacts>
          <ToolFact label="User id"><span className="font-mono text-xs">{user.userId}</span></ToolFact>
          <ToolFact label="Registered">{utc(user.registeredAt)}</ToolFact>
          <ToolFact label="Sign-in">{user.providers?.join(", ") || "—"}</ToolFact>
          <ToolFact label="Email verified">{user.emailVerified ? "Yes" : "No"}</ToolFact>
          <ToolFact label="Profile">{user.profileCompleted ? "Completed" : "Not completed"}</ToolFact>
          <ToolFact label="Last access">{age(user.lastSessionAt, "Never")}</ToolFact>
        </ToolFacts>
      </ToolDetailSection>

      <ToolDetailSection title="Usage">
        <AdminStatGrid stats={[
          { label: "Messages", value: formatAdminCount(detail.messages.total),
            hint: `${formatAdminCount(detail.messages.last7d)} in 7d · ${formatAdminCount(detail.messages.last30d)} in 30d` },
          { label: "Runs", value: formatAdminCount(detail.runs.total),
            hint: `${formatAdminCount(detail.runs.active)} active · ${formatAdminCount(detail.runs.last30d)} in 30d` },
          { label: "Spaces", value: formatAdminCount(detail.spaces.length),
            hint: `${formatAdminCount(detail.spaces.filter((space) => space.role === "owner").length)} owned` },
          { label: "Pages created", value: formatAdminCount(detail.pagesCreated) },
        ]} />
        {Object.keys(detail.runs.byStatus).length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Runs by status: {Object.entries(detail.runs.byStatus)
              .map(([status, value]) => `${status} ${formatAdminCount(value)}`).join(" · ")}
            {detail.runs.lastRunAt && ` · last ${age(detail.runs.lastRunAt)}`}
          </p>
        )}
      </ToolDetailSection>

      <ToolDetailSection title="Messages per day, last 30 days">
        <AdminDailyBars label="This user's daily messages" points={detail.activity} />
      </ToolDetailSection>

      <ToolDetailSection title={`Spaces (${detail.spaces.length})`}>
        <AdminTable id="us" label="Spaces" rows={detail.spaces} rowKey={(space) => space.spaceId}
          defaultSort="joined" empty="Not a member of any Space."
          columns={[
            { key: "name", label: "Space", value: (space) => space.name,
              render: (space) => <span className="block truncate font-bold">{space.name}</span> },
            { key: "role", label: "Role", value: (space) => space.role,
              render: (space) => <Badge variant="secondary">{space.role}</Badge> },
            { key: "members", label: "Members", numeric: true, value: (space) => space.members,
              render: (space) => formatAdminCount(space.members) },
            { key: "messages", label: "Their messages", numeric: true, value: (space) => space.messages,
              render: (space) => formatAdminCount(space.messages) },
            { key: "billing", label: "Plan", value: (space) => space.billing?.status,
              render: (space) => <span className="text-xs">{space.billing
                ? `${space.billing.plan} · ${space.billing.status} · ${space.billing.seats} seats${space.billing.cancelAtPeriodEnd ? " · cancels" : ""}`
                : "Free"}</span> },
            { key: "joined", label: "Joined", numeric: true, value: (space) => adminTime(space.joinedAt),
              render: (space) => <TimeCell value={space.joinedAt} /> },
          ]} />
      </ToolDetailSection>

      <ToolDetailSection title={`Agents (${detail.agents.length})`}>
        <AdminTable id="ua" label="Agents" rows={detail.agents}
          rowKey={(agent) => `${agent.spaceId}:${agent.machineId}:${agent.harness}`}
          defaultSort="updated" empty="No Agent registered."
          columns={[
            { key: "name", label: "Agent", value: (agent) => agent.displayName,
              render: (agent) => <span className="font-bold">{agent.displayName}</span> },
            { key: "harness", label: "Runtime", value: (agent) => agent.harness, render: (agent) => agent.harness },
            { key: "space", label: "Space", value: (agent) => spaceName(agent.spaceId),
              render: (agent) => <span className="block truncate">{spaceName(agent.spaceId)}</span> },
            { key: "updated", label: "Updated", numeric: true, value: (agent) => adminTime(agent.updatedAt),
              render: (agent) => <TimeCell value={agent.updatedAt} /> },
          ]} />
      </ToolDetailSection>

      <ToolDetailSection title={`Machines (${detail.machines.length})`}>
        <AdminTable id="um" label="Machines" rows={detail.machines} rowKey={(machine) => machine.machineId}
          defaultSort="updated" empty="No Machine enrolled."
          columns={[
            { key: "id", label: "Machine", value: (machine) => machine.machineId,
              render: (machine) => <span className="block truncate font-mono text-xs">{machine.machineId}</span> },
            { key: "status", label: "Status", value: (machine) => machine.status,
              render: (machine) => <Badge variant={machine.status === "online" ? "default" : "secondary"}>{machine.status}</Badge> },
            { key: "created", label: "Enrolled", numeric: true, value: (machine) => adminTime(machine.createdAt),
              render: (machine) => <TimeCell value={machine.createdAt} /> },
            { key: "updated", label: "Last seen", numeric: true, value: (machine) => adminTime(machine.updatedAt),
              render: (machine) => <TimeCell value={machine.updatedAt} /> },
          ]} />
      </ToolDetailSection>

      <ToolDetailSection title={`Connectors added (${detail.connectors.length})`}>
        <AdminTable id="uc" label="Connectors" rows={detail.connectors}
          rowKey={(connector) => `${connector.spaceId}:${connector.providerId}`}
          defaultSort="created" empty="No connector added."
          columns={[
            { key: "provider", label: "Connector", value: (connector) => connector.providerName,
              render: (connector) => <span className="font-bold">{connector.providerName}</span> },
            { key: "space", label: "Space", value: (connector) => spaceName(connector.spaceId),
              render: (connector) => <span className="block truncate">{spaceName(connector.spaceId)}</span> },
            { key: "status", label: "Status", value: (connector) => connector.status,
              render: (connector) => <Badge variant={connector.status === "error" ? "destructive" : "secondary"}>{connector.status}</Badge> },
            { key: "created", label: "Added", numeric: true, value: (connector) => adminTime(connector.createdAt),
              render: (connector) => <TimeCell value={connector.createdAt} /> },
          ]} />
      </ToolDetailSection>

      <ToolDetailSection title={`Sessions (${detail.sessions.length})`}>
        <AdminTable id="ux" label="Sessions" rows={detail.sessions} rowKey={(session) => `${session.createdAt}:${session.expiresAt}`}
          defaultSort="last" empty="No session on record."
          columns={[
            { key: "state", label: "State", value: (session) => (session.active ? "active" : "expired"),
              render: (session) => <Badge variant={session.active ? "default" : "secondary"}>{session.active ? "active" : "expired"}</Badge> },
            { key: "created", label: "Signed in", numeric: true, value: (session) => adminTime(session.createdAt),
              render: (session) => <span className="text-xs">{utc(session.createdAt)}</span> },
            { key: "last", label: "Last active", numeric: true, value: (session) => adminTime(session.lastActiveAt),
              render: (session) => <span className="text-xs">{utc(session.lastActiveAt)}</span> },
            { key: "expires", label: "Expires", numeric: true, value: (session) => adminTime(session.expiresAt),
              render: (session) => <span className="text-xs text-muted-foreground">{utc(session.expiresAt)}</span> },
          ]} />
        <p className="mt-2 text-xs text-muted-foreground">
          Session addresses and devices are not shown to operators.
        </p>
      </ToolDetailSection>
    </>
  );
}
