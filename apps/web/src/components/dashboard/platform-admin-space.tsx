"use client";

/**
 * One Space's detail, opened from the Spaces list (`?space=<id>`).
 *
 * Metadata only — members and roles, Agents, connectors by name and state,
 * Automation and Run counts, billing state, paid-call totals, storage. No
 * message, page, prompt, or connector content. The Hub records each open in
 * the admin audit trail.
 */

import type { AdminSpaceDetail } from "@xmatrix/protocol";
import { ChevronLeft } from "lucide-react";

import { AdminTable } from "./admin-table";
import { AdminPaperAction } from "./admin-paper";
import { PaidCallsTable, WebhookEventsTable } from "./platform-admin-billing";
import { AdminDetailHeader, TimeCell, adminTimeColumn, adminAge, adminAutomationStats, adminPercent, adminStatusLine, adminSum, adminUtc } from "./platform-admin-cells";
import { openAdminUser, useAdminSpaceDetail } from "./platform-admin-data";
import { adminTime, formatAdminBytes, formatAdminCount } from "./platform-admin-overview";
import { ToolDetailSection, ToolFact, ToolFacts } from "./tool-split";
import { AdminMessageBars, AdminQueryView, AdminStatGrid } from "./workspace-platform-admin-view";

export function AdminSpaceDetailView({ token, spaceId, onBack }: { token?: string; spaceId: string; onBack: () => void }) {
  return (
    <div className="app-admin-space-detail">
      <AdminQueryView query={useAdminSpaceDetail(token, spaceId)} generatedAt={(detail) => detail.generatedAt}
        lead={<AdminPaperAction onClick={onBack} className="-ml-1 mr-auto">
          <ChevronLeft className="size-4" /> Spaces
        </AdminPaperAction>}
        emptyTitle="Space not found" emptyBody="No Space has this id.">
        {(detail) => <div className="space-y-7"><SpaceDetailBody detail={detail} /></div>}
      </AdminQueryView>
    </div>
  );
}

function SpaceDetailBody({ detail }: { detail: AdminSpaceDetail }) {
  const { space, totals, automations, runs, billing } = detail;
  const emails = new Map(detail.members.map((member) => [member.userId, member.email]));
  const person = (userId: string | undefined) => (userId && emails.get(userId)) || userId || "—";
  const agentShare = adminPercent(totals.agentMessages, totals.humanMessages + totals.agentMessages);
  const occurrences = adminSum(automations.occurrencesByStatus);
  const failedRuns = runs.byStatus.failed ?? 0;
  return (
    <>
      <AdminDetailHeader title={space.name} truncated={detail.truncated}>
          Owner {space.ownerEmail || space.ownerUserId} · created {adminUtc(space.createdAt)}
          {space.lastMessageAt && ` · last message ${adminAge(space.lastMessageAt)}`}
      </AdminDetailHeader>

      <ToolDetailSection title="Usage">
        <AdminStatGrid stats={[
          { label: "Members", value: formatAdminCount(totals.members),
            hint: `${formatAdminCount(totals.activeInvites)} open invites · ${formatAdminCount(totals.pendingJoinRequests)} join requests` },
          { label: "Channels", value: formatAdminCount(totals.channels) },
          { label: "Agents", value: formatAdminCount(totals.agents) },
          { label: "Messages", value: formatAdminCount(totals.messages),
            hint: `${formatAdminCount(totals.messagesLast7d)} in 7d · ${formatAdminCount(totals.messagesLast30d)} in 30d` },
          { label: "Agent share", value: `${agentShare}%`,
            hint: `${formatAdminCount(totals.agentMessages)} agent · ${formatAdminCount(totals.humanMessages)} human` },
          { label: "Pages", value: formatAdminCount(totals.pages) },
          { label: "Storage", value: formatAdminBytes(totals.storageLogicalBytes) },
          { label: "Runs, 30d", value: formatAdminCount(runs.total),
            hint: runs.total > 0 ? `${adminPercent(failedRuns, runs.total)}% failed` : undefined },
        ]} />
      </ToolDetailSection>

      <ToolDetailSection title={`Messages per day, last ${detail.activity.length} days`}>
        <AdminMessageBars label="This Space's daily messages" activity={detail.activity} />
      </ToolDetailSection>

      <ToolDetailSection title="Billing">
        <div className="app-admin-account">
          <ToolFacts>
            <ToolFact label="Plan">{billing ? billing.plan : "Free"}</ToolFact>
            {billing && <>
              <ToolFact label="Status">{billing.status}{billing.cancelAtPeriodEnd ? " · cancels at period end" : ""}</ToolFact>
              <ToolFact label="Seats">{formatAdminCount(billing.seats)}</ToolFact>
              <ToolFact label="Provider">{billing.provider ?? "—"}</ToolFact>
              <ToolFact label="Period ends">{adminUtc(billing.currentPeriodEnd)}</ToolFact>
              {billing.graceUntil && <ToolFact label="Grace until">{adminUtc(billing.graceUntil)}</ToolFact>}
              <ToolFact label="Updated"><TimeCell value={billing.updatedAt} /></ToolFact>
            </>}
            <ToolFact label="Free messages">{formatAdminCount(detail.freeMessages)}</ToolFact>
          </ToolFacts>
        </div>
        {detail.webhookEvents.length > 0 && (
          <div className="mt-3">
            <WebhookEventsTable id="sw" events={detail.webhookEvents} />
          </div>
        )}
      </ToolDetailSection>

      <ToolDetailSection title={`Members (${detail.members.length})`}>
        <AdminTable id="sm" label="Members" rows={detail.members} rowKey={(member) => member.userId}
          onRowClick={(member) => openAdminUser(member.userId)}
          search={(member) => [member.userId, member.email, member.role].filter(Boolean).join(" ")}
          searchPlaceholder="Email, role, id" defaultSort="joined" empty="No member."
          columns={[
            { key: "member", label: "Member", value: (member) => member.email || member.userId,
              render: (member) => <span className="block truncate font-bold">{member.email || member.userId}</span> },
            { key: "role", label: "Role", value: (member) => member.role,
              render: (member) => <span className="text-xs">{member.role}</span> },
            { key: "messages", mobile: "metric", label: "Messages", numeric: true, value: (member) => member.messages,
              render: (member) => formatAdminCount(member.messages) },
            { key: "joined", label: "Joined", numeric: true, value: (member) => adminTime(member.joinedAt),
              render: (member) => <TimeCell value={member.joinedAt} /> },
          ]} />
      </ToolDetailSection>

      <ToolDetailSection title={`Agents (${detail.agents.length})`}>
        <AdminTable id="sa" label="Agents" rows={detail.agents}
          rowKey={(agent) => `${agent.machineId}:${agent.harness}:${agent.displayName}`}
          onRowClick={(agent) => openAdminUser(agent.ownerUserId)}
          defaultSort="updated" empty="No Agent registered."
          columns={[
            { key: "name", label: "Agent", value: (agent) => agent.displayName,
              render: (agent) => <span className="block truncate font-bold">{agent.displayName}</span> },
            { key: "harness", label: "Runtime", value: (agent) => agent.harness,
              render: (agent) => <span className="text-xs">{agent.harness}</span> },
            { key: "owner", label: "Owner", value: (agent) => person(agent.ownerUserId),
              render: (agent) => <span className="block truncate text-xs text-muted-foreground">{person(agent.ownerUserId)}</span> },
            { key: "machine", mobile: false, label: "Machine", value: (agent) => agent.machineId,
              render: (agent) => <span className="block truncate font-mono text-xs">{agent.machineId}</span> },
            adminTimeColumn("updated", "Updated", (agent: { updatedAt: string }) => agent.updatedAt),
          ]} />
      </ToolDetailSection>

      <ToolDetailSection title={`Connectors (${detail.connectors.length})`}>
        <AdminTable id="sc" label="Connectors" rows={detail.connectors}
          rowKey={(connector) => `${connector.providerId}:${connector.createdAt}`}
          defaultSort="created" empty="No connector added."
          columns={[
            { key: "provider", label: "Connector", value: (connector) => connector.providerName,
              render: (connector) => <span className="block truncate font-bold">{connector.providerName}</span> },
            { key: "status", label: "Status", value: (connector) => connector.status,
              render: (connector) => <span className="text-xs">{connector.status}</span> },
            { key: "auth", mobile: false, label: "Auth", value: (connector) => connector.authMode,
              render: (connector) => <span className="text-xs text-muted-foreground">{connector.authMode}</span> },
            { key: "by", mobile: false, label: "Added by", value: (connector) => person(connector.createdBy),
              render: (connector) => <span className="block truncate text-xs text-muted-foreground">{person(connector.createdBy)}</span> },
            { key: "created", label: "Added", numeric: true, value: (connector) => adminTime(connector.createdAt),
              render: (connector) => <TimeCell value={connector.createdAt} /> },
            { key: "checked", mobile: false, label: "Checked", numeric: true, value: (connector) => adminTime(connector.lastCheckedAt),
              render: (connector) => <TimeCell value={connector.lastCheckedAt} /> },
          ]} />
      </ToolDetailSection>

      <ToolDetailSection title="Automations and Runs">
        <AdminStatGrid stats={[
          ...adminAutomationStats(automations, 30),
          { label: "Automation runs", value: formatAdminCount(automations.runCount),
            hint: automations.lastRunAt ? `last ${adminAge(automations.lastRunAt)}` : undefined },
        ]} />
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          {occurrences > 0 && <p>Occurrences by status: {adminStatusLine(automations.occurrencesByStatus)}</p>}
          <p>
            Runs started in 30 days: {adminStatusLine(runs.byStatus) || "none"}
            {runs.lastRunAt && ` · last ${adminAge(runs.lastRunAt)}`}
          </p>
        </div>
      </ToolDetailSection>

      <ToolDetailSection title="Paid calls, last 30 days">
        <PaidCallsTable id="sp" calls={detail.paidCalls} />
      </ToolDetailSection>

      {detail.storage.length > 0 && (
        <ToolDetailSection title="Storage by category">
          <AdminTable id="sg" label="Storage" rows={detail.storage} rowKey={(entry) => entry.category}
            defaultSort="bytes" empty="Nothing stored."
            columns={[
              { key: "category", label: "Category", value: (entry) => entry.category,
                render: (entry) => <span className="block truncate">{entry.category}</span> },
              { key: "rows", mobile: "metric", label: "Rows", numeric: true, value: (entry) => entry.rows,
                render: (entry) => formatAdminCount(entry.rows) },
              { key: "bytes", mobile: "metric", label: "Size", numeric: true, value: (entry) => entry.logicalBytes,
                render: (entry) => formatAdminBytes(entry.logicalBytes) },
            ]} />
        </ToolDetailSection>
      )}
    </>
  );
}
