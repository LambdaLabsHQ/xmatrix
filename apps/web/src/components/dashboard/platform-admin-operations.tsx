"use client";

/**
 * The platform's moving parts: Machines and the runtimes on them, Runs,
 * Automations, and the event delivery queue. Statuses, counts, and times only;
 * Machine host names, Run payloads, and Automation prompts or errors are not
 * part of this read.
 */

import type { AdminOperations, AdminOperationsHarness, AdminOperationsMachine } from "@xmatrix/protocol";

import { noticeClass } from "@/components/ui/status-tone";
import { AdminTable, type AdminColumn } from "./admin-table";
import { TimeCell, adminAge, adminPercent, adminStatusLine, adminSum } from "./platform-admin-cells";
import { openAdminUser, useAdminOperations } from "./platform-admin-data";
import { adminTime, formatAdminCount } from "./platform-admin-overview";
import { ToolDetailSection } from "./tool-split";
import { AdminDailyBars, AdminQueryView, AdminStatGrid } from "./workspace-platform-admin-view";

/** An undelivered event older than this means delivery has stalled. */
const OUTBOX_STALL_MS = 10 * 60 * 1_000;

const MACHINE_COLUMNS: AdminColumn<AdminOperationsMachine>[] = [
  { key: "machine", label: "Machine", value: (machine) => machine.machineId,
    render: (machine) => <span className="block truncate font-mono text-xs">{machine.machineId}</span> },
  { key: "owner", label: "Owner", value: (machine) => machine.ownerEmail || machine.ownerUserId,
    render: (machine) => <span className="block truncate text-xs text-muted-foreground">{machine.ownerEmail || machine.ownerUserId}</span> },
  { key: "status", label: "Status", value: (machine) => machine.status,
    render: (machine) => <span className="text-xs">{machine.status}</span> },
  { key: "agents", mobile: "metric", label: "Agents", numeric: true, value: (machine) => machine.agents,
    render: (machine) => formatAdminCount(machine.agents) },
  { key: "runs", mobile: "metric", label: "Active runs", numeric: true, value: (machine) => machine.activeRuns,
    render: (machine) => formatAdminCount(machine.activeRuns) },
  { key: "enrolled", mobile: false, label: "Enrolled", numeric: true, value: (machine) => adminTime(machine.enrolledAt),
    render: (machine) => <TimeCell value={machine.enrolledAt} /> },
  { key: "seen", label: "Last seen", numeric: true, value: (machine) => adminTime(machine.lastSeenAt),
    render: (machine) => <TimeCell value={machine.lastSeenAt} /> },
];

const HARNESS_COLUMNS: AdminColumn<AdminOperationsHarness>[] = [
  { key: "harness", label: "Runtime", value: (row) => row.harness,
    render: (row) => <span className="font-bold">{row.harness}</span> },
  { key: "agents", mobile: "metric", label: "Agents", numeric: true, value: (row) => row.agents,
    render: (row) => formatAdminCount(row.agents) },
  { key: "spaces", mobile: "metric", label: "Spaces", numeric: true, value: (row) => row.spaces,
    render: (row) => formatAdminCount(row.spaces) },
  { key: "owners", mobile: "metric", label: "Owners", numeric: true, value: (row) => row.owners,
    render: (row) => formatAdminCount(row.owners) },
];

export function PlatformAdminOperations({ token }: { token?: string }) {
  return (
    <AdminQueryView title="Operations" query={useAdminOperations(token)} generatedAt={(operations) => operations.generatedAt}
      emptyTitle="No operations data yet" emptyBody="Machines, Runs, and Automations appear here once they exist.">
      {(operations) => <div className="space-y-7"><OperationsBody operations={operations} /></div>}
    </AdminQueryView>
  );
}

function OperationsBody({ operations }: { operations: AdminOperations }) {
  const { runs, automations, outbox } = operations;
  const machines = adminSum(operations.machinesByStatus);
  const online = operations.machinesByStatus.online ?? 0;
  const started = adminSum(runs.byStatus);
  const failedRuns = runs.byStatus.failed ?? 0;
  const occurrences = adminSum(automations.occurrencesByStatus);
  const failedOccurrences = automations.occurrencesByStatus.failed ?? 0;
  const failedEvents = outbox.byStatus.failed ?? 0;
  const undelivered = (outbox.byStatus.pending ?? 0) + (outbox.byStatus.leased ?? 0);
  const stalled = outbox.oldestPendingAt !== undefined &&
    Date.now() - Date.parse(outbox.oldestPendingAt) > OUTBOX_STALL_MS;
  const cut = (key: string, what: string) =>
    operations.truncated.includes(key) ? `Showing the most recent ${what} only; the Hub caps one read.` : undefined;
  return (
    <>
      {(stalled || failedEvents > 0 || automations.overdue > 0) && (
        <div role="status" className={noticeClass(failedEvents > 0 ? "alert" : "attention", "space-y-1 rounded-lg px-4 py-3")}>
          {stalled && <p>Event delivery is behind: the oldest undelivered event was queued {adminAge(outbox.oldestPendingAt)}.</p>}
          {failedEvents > 0 && <p>{formatAdminCount(failedEvents)} events failed delivery.</p>}
          {automations.overdue > 0 && <p>{formatAdminCount(automations.overdue)} Automation occurrences are past their scheduled time.</p>}
        </div>
      )}

      <ToolDetailSection title="Machines">
        <AdminStatGrid stats={[
          { label: "Machines", value: formatAdminCount(machines),
            hint: adminStatusLine(operations.machinesByStatus) || undefined },
          { label: "Online", value: formatAdminCount(online), hint: `${adminPercent(online, machines)}% of Machines` },
          { label: "Active runs", value: formatAdminCount(runs.active) },
          { label: "Runtimes", value: formatAdminCount(operations.harnesses.length) },
        ]} />
        <div className="mt-3">
          <AdminTable id="om" label="Machines" rows={operations.machines} rowKey={(machine) => machine.machineId}
            columns={MACHINE_COLUMNS} defaultSort="seen" onRowClick={(machine) => openAdminUser(machine.ownerUserId)}
            search={(machine) => [machine.machineId, machine.ownerEmail, machine.ownerUserId, machine.status].filter(Boolean).join(" ")}
            searchPlaceholder="Machine, owner, status" empty="No Machine matches this search."
            note={cut("machines", "Machines")} />
        </div>
      </ToolDetailSection>

      <ToolDetailSection title="Agent runtimes">
        <AdminTable id="oh" label="Agent runtimes" rows={operations.harnesses} rowKey={(row) => row.harness}
          columns={HARNESS_COLUMNS} defaultSort="agents" empty="No Agent registered." />
      </ToolDetailSection>

      <ToolDetailSection title={`Runs, last ${operations.days} days`}>
        <AdminStatGrid stats={[
          { label: "Started", value: formatAdminCount(started) },
          { label: "Failed", value: formatAdminCount(failedRuns), hint: `${adminPercent(failedRuns, started)}% of started` },
          { label: "Completed", value: formatAdminCount((runs.byStatus.completed ?? 0) + (runs.byStatus.exited ?? 0)) },
          { label: "Running now", value: formatAdminCount(runs.active) },
        ]} />
        {started > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">By status: {adminStatusLine(runs.byStatus)}</p>
        )}
        <div className="mt-4">
          <AdminDailyBars label="Runs started per day" points={runs.daily.map((day) => ({
            date: day.date,
            messages: day.started,
            title: `${day.date}: ${day.started} started, ${day.failed} failed`,
          }))} />
        </div>
      </ToolDetailSection>

      <ToolDetailSection title="Automations">
        <AdminStatGrid stats={[
          { label: "Automations", value: formatAdminCount(automations.total),
            hint: `${formatAdminCount(automations.enabled)} enabled` },
          { label: "Last run errored", value: formatAdminCount(automations.withError) },
          { label: `Occurrences, ${operations.days}d`, value: formatAdminCount(occurrences),
            hint: occurrences > 0 ? `${adminPercent(failedOccurrences, occurrences)}% failed` : undefined },
          { label: "Overdue", value: formatAdminCount(automations.overdue), hint: "Pending past their time" },
        ]} />
        {occurrences > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">Occurrences by status: {adminStatusLine(automations.occurrencesByStatus)}</p>
        )}
      </ToolDetailSection>

      <ToolDetailSection title="Event delivery">
        <AdminStatGrid stats={[
          { label: "Undelivered", value: formatAdminCount(undelivered),
            hint: outbox.oldestPendingAt ? `oldest ${adminAge(outbox.oldestPendingAt)}` : "Queue is empty" },
          { label: "Delivered", value: formatAdminCount(outbox.byStatus.delivered ?? 0) },
          { label: "Failed", value: formatAdminCount(failedEvents) },
          { label: "Most attempts", value: formatAdminCount(outbox.maxAttempts) },
        ]} />
      </ToolDetailSection>
    </>
  );
}
