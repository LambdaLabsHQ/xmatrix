"use client";

/**
 * Platform billing: every Space subscription, the billing provider's webhook
 * deliveries, and the calls xMatrix itself pays for. Provider ids, payloads,
 * and prompts never reach this view; kinds, counts, and states do.
 */

import type {
  AdminBillingWebhookEvent,
  AdminOperations,
  AdminOperationsSubscription,
  AdminPaidCallKind,
} from "@xmatrix/protocol";

import { noticeClass } from "@/components/ui/status-tone";
import { AdminTable, type AdminColumn } from "./admin-table";
import { TimeCell, adminStatusLine, adminSum } from "./platform-admin-cells";
import { openAdminSpace, useAdminOperations } from "./platform-admin-data";
import { adminTime, formatAdminCount } from "./platform-admin-overview";
import { ToolDetailSection } from "./tool-split";
import { AdminQueryView, AdminStatGrid } from "./workspace-platform-admin-view";

/** Calls by kind; a rejected or uncertain outcome is the one to look at. */
export function PaidCallsTable({ id, calls }: { id: string; calls: readonly AdminPaidCallKind[] }) {
  return (
    <AdminTable id={id} label="Paid calls" rows={calls} rowKey={(row) => row.kind}
      defaultSort="calls" empty="No paid call in this window."
      columns={[
        { key: "kind", label: "Kind", value: (row) => row.kind,
          render: (row) => <span className="font-bold">{row.kind}</span> },
        { key: "calls", mobile: "metric", label: "Calls", numeric: true, value: (row) => row.calls,
          render: (row) => formatAdminCount(row.calls) },
        { key: "units", mobile: "metric", label: "Units", numeric: true, value: (row) => row.units,
          render: (row) => formatAdminCount(row.units) },
        { key: "credits", mobile: "metric", label: "Credits", numeric: true, value: (row) => row.credits,
          render: (row) => formatAdminCount(row.credits) },
        { key: "outcomes", label: "Outcomes", value: (row) => adminStatusLine(row.byOutcome),
          render: (row) => <span className="text-xs text-muted-foreground">{adminStatusLine(row.byOutcome) || "—"}</span> },
      ]} />
  );
}

export function WebhookEventsTable({ id, events, spaceName }: {
  id: string;
  events: readonly AdminBillingWebhookEvent[];
  /** Present on the platform list, where events span Spaces. */
  spaceName?: (spaceId: string) => string;
}) {
  const columns: AdminColumn<AdminBillingWebhookEvent>[] = [
    { key: "type", label: "Event", value: (event) => event.eventType,
      render: (event) => <span className="block truncate font-mono text-xs">{event.eventType}</span> },
    ...(spaceName ? [{ key: "space", label: "Space", value: (event: AdminBillingWebhookEvent) => spaceName(event.spaceId),
      render: (event: AdminBillingWebhookEvent) => <span className="block truncate">{spaceName(event.spaceId)}</span> }] : []),
    { key: "outcome", label: "Outcome", value: (event) => event.outcome,
      render: (event) => <span className="text-xs">{event.outcome}</span> },
    { key: "at", label: "Processed", numeric: true, value: (event) => adminTime(event.processedAt),
      render: (event) => <TimeCell value={event.processedAt} /> },
  ];
  return (
    <AdminTable id={id} label="Billing webhooks" rows={events}
      rowKey={(event) => `${event.spaceId}:${event.eventType}:${event.processedAt}`}
      columns={columns} defaultSort="at" empty="No billing webhook in this window." />
  );
}

const SUBSCRIPTION_COLUMNS: AdminColumn<AdminOperationsSubscription>[] = [
  { key: "space", label: "Space", value: (row) => row.spaceName,
    render: (row) => <span className="block truncate font-bold">{row.spaceName}</span> },
  { key: "plan", label: "Plan", value: (row) => row.plan, render: (row) => <span className="text-xs">{row.plan}</span> },
  { key: "status", label: "Status", value: (row) => row.status,
    render: (row) => <span className="text-xs">{row.status}{row.cancelAtPeriodEnd ? " · cancels" : ""}</span> },
  { key: "seats", mobile: "metric", label: "Seats", numeric: true, value: (row) => row.seats,
    render: (row) => formatAdminCount(row.seats) },
  { key: "provider", mobile: false, label: "Provider", value: (row) => row.provider,
    render: (row) => <span className="text-xs text-muted-foreground">{row.provider ?? "—"}</span> },
  { key: "period", label: "Period ends", numeric: true, value: (row) => adminTime(row.currentPeriodEnd),
    render: (row) => <span className="whitespace-nowrap text-xs text-muted-foreground" title={row.currentPeriodEnd}>{row.currentPeriodEnd?.slice(0, 10) ?? "—"}</span> },
  { key: "grace", label: "Grace until", numeric: true, value: (row) => adminTime(row.graceUntil),
    render: (row) => <span className="whitespace-nowrap text-xs text-muted-foreground" title={row.graceUntil}>{row.graceUntil?.slice(0, 10) ?? "—"}</span> },
  { key: "updated", mobile: false, label: "Updated", numeric: true, value: (row) => adminTime(row.updatedAt),
    render: (row) => <TimeCell value={row.updatedAt} /> },
];

export function PlatformAdminBilling({ token }: { token?: string }) {
  return (
    <AdminQueryView title="Billing" query={useAdminOperations(token)} generatedAt={(operations) => operations.generatedAt}
      emptyTitle="No billing data yet" emptyBody="Subscriptions and paid calls appear here once a Space has them.">
      {(operations) => <div className="space-y-7"><BillingBody operations={operations} /></div>}
    </AdminQueryView>
  );
}

function BillingBody({ operations }: { operations: AdminOperations }) {
  const { billing } = operations;
  const spaceNames = new Map(billing.subscriptions.map((row) => [row.spaceId, row.spaceName]));
  const inGrace = billing.subscriptions.filter((row) => row.graceUntil).length;
  const cancelling = billing.subscriptions.filter((row) => row.cancelAtPeriodEnd).length;
  return (
    <>
      {inGrace > 0 && (
        <p role="status" className={noticeClass("attention", "rounded-lg px-4 py-3")}>
          {inGrace === 1 ? "1 Space is" : `${inGrace} Spaces are`} in a payment grace period.
        </p>
      )}
      <ToolDetailSection title="Subscriptions">
        <AdminStatGrid stats={[
          { label: "Subscriptions", value: formatAdminCount(billing.subscriptions.length),
            hint: adminStatusLine(billing.byStatus) || undefined },
          { label: "Seats", value: formatAdminCount(billing.subscriptions.reduce((sum, row) => sum + row.seats, 0)) },
          { label: "In grace", value: formatAdminCount(inGrace) },
          { label: "Cancelling", value: formatAdminCount(cancelling), hint: "At period end" },
        ]} />
        <div className="mt-3">
          <AdminTable id="bs" label="Subscriptions" rows={billing.subscriptions} rowKey={(row) => row.spaceId}
            columns={SUBSCRIPTION_COLUMNS} defaultSort="updated" onRowClick={(row) => openAdminSpace(row.spaceId)}
            search={(row) => [row.spaceName, row.spaceId, row.plan, row.status].join(" ")}
            searchPlaceholder="Space, plan, status" empty="No Space has a subscription."
            note={operations.truncated.includes("subscriptions") ? "Showing the most recently updated subscriptions only." : undefined} />
        </div>
      </ToolDetailSection>
      <ToolDetailSection title={`Billing webhooks, last ${operations.days} days`}>
        <p className="mb-3 text-xs text-muted-foreground">
          {formatAdminCount(adminSum(billing.webhooksByOutcome))} recorded
          {adminStatusLine(billing.webhooksByOutcome) && ` · ${adminStatusLine(billing.webhooksByOutcome)}`}
        </p>
        <WebhookEventsTable id="bw" events={billing.webhookEvents}
          spaceName={(spaceId) => spaceNames.get(spaceId) ?? spaceId} />
      </ToolDetailSection>
      <ToolDetailSection title={`Platform paid calls, last ${operations.days} days`}>
        <p className="mb-3 text-xs text-muted-foreground">
          Calls xMatrix pays an upstream service for, by kind. Prompts and answers are not recorded.
        </p>
        <PaidCallsTable id="bp" calls={operations.paidCalls} />
      </ToolDetailSection>
    </>
  );
}
