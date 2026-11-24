"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import {
  MACHINE_HARNESS_QUOTA_ACCESS_CAPABILITY, agentPresetById, parseHarnessInventory,
  type HarnessActionStatus, type HarnessQuotaAccess, type SerializedMachineDaemon,
} from "@xmatrix/protocol";

import { Button } from "@/components/ui/button";
import { noticeClass } from "@/components/ui/status-tone";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { UserFacingProblem, userErrorMessage } from "@/lib/user-facing-error";

import { CenteredDialogShell, DialogButton, DialogPanelFooter, DialogPanelHeader } from "./centered-dialog-shell";
import { queueHarnessAction, readHarnessAction } from "./machine-harness-api";
import { ToolDetailSection } from "./tool-split";
import { useOwnerDaemons } from "./harness-sign-in";

/* Some harnesses (Cursor) have no official way to ask for their quota: the
   only way is to read the sign-in the harness stored for itself on its
   machine. That sign-in is not permission for xMatrix, so its quota is
   unknown until the machine's owner allows the read here, per machine. The
   daemon keeps the grant; this shows and changes it, and nothing else. */

/** Which harness on whose Machine. */
export type QuotaAccessTarget = {
  machineName: string;
  key: { ownerUserId: string; machineId: string; harness: string };
};

type DaemonView = Pick<SerializedMachineDaemon, "status" | "metadata"> & { machineId?: string; hostId?: string };

/** What the viewer sees of a harness's quota-read grant on one Machine. */
export function harnessQuotaAccessView(input: {
  target: QuotaAccessTarget; userId?: string; daemons?: readonly DaemonView[];
}) {
  const { target, userId } = input;
  const preset = agentPresetById(target.key.harness);
  const offered = preset?.management?.quotaRead === "sign_in_grant";
  const owner = Boolean(userId && target.key.ownerUserId === userId);
  const daemon = input.daemons?.find((item) => item.machineId === target.key.machineId && item.status === "online");
  const item = parseHarnessInventory(daemon?.metadata.harnesses)?.items.find((entry) => entry.id === target.key.harness);
  const capabilities = daemon?.metadata.capabilities;
  const capable = Array.isArray(capabilities) && capabilities.includes(MACHINE_HARNESS_QUOTA_ACCESS_CAPABILITY);
  return {
    /** Its quota is read only under a grant, so without one it is unknown. */
    offered,
    /** Only the machine's owner can allow or stop the read. */
    canChange: offered && owner,
    state: item?.quotaAccess as HarnessQuotaAccess | undefined,
    program: preset?.displayName ?? target.key.harness,
    daemon,
    blocker: !daemon ? "Connect this machine to change this."
      : !capable ? "Update this machine's xMatrix daemon to allow this." : undefined,
  };
}

/** Queue a grant change and wait for the machine's answer. */
async function changeQuotaAccess(token: string, daemon: DaemonView | undefined, harness: string, on: boolean) {
  if (!daemon?.machineId) throw new UserFacingProblem("This machine is offline.", true);
  const { controlId } = await queueHarnessAction(token, daemon.machineId, daemon.hostId, harness,
    on ? "quota_access_on" : "quota_access_off", AbortSignal.timeout(30_000));
  for (const started = Date.now(); Date.now() - started < 2 * 60_000;) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const status: HarnessActionStatus = await readHarnessAction(token, controlId);
    if (status.status === "queued" || status.status === "running") continue;
    if (status.status !== "succeeded") {
      throw new UserFacingProblem(status.error ?? "The machine did not make the change.", true);
    }
    return status.result?.item?.quotaAccess;
  }
  throw new UserFacingProblem("The machine has not answered yet. Check again in a moment.", true);
}

/** The confirmation, in the words the decision needs. */
export function quotaAccessConsentText(program: string, machineName: string) {
  return [
    `xMatrix reads ${program}'s sign-in only on this computer (${machineName}), and only to ask ${program} for its own usage.`,
    `Nothing from the sign-in leaves this computer. Only the usage ${program} reports back is shown here.`,
    "You can turn this off at any time, here or in Settings → Legal and privacy, and it stops at once.",
  ];
}

function QuotaAccessConsent({ program, machineName, busy, onAnswer }: {
  program: string; machineName: string; busy: boolean; onAnswer: (allow: boolean) => void;
}) {
  return (
    <CenteredDialogShell open busy={busy} labelledBy="quota-access-title" onCancel={() => onAnswer(false)} panelClassName="max-w-md">
      <DialogPanelHeader labelledBy="quota-access-title" title={`Allow reading ${program}'s sign-in to show its quota?`} />
      <div className="space-y-2 px-5 py-4 text-sm" data-testid="quota-access-consent">
        <p className="text-muted-foreground">{program} has no official way to ask for its quota.</p>
        {quotaAccessConsentText(program, machineName).map((line) => <p key={line}>{line}</p>)}
      </div>
      <DialogPanelFooter>
        <DialogButton onClick={() => onAnswer(false)}>Cancel</DialogButton>
        <DialogButton tone="primary" busy={busy} onClick={() => onAnswer(true)}>Allow on {machineName}</DialogButton>
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}

function useQuotaAccessChange(token: string, userId: string, onChanged?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { daemon: DaemonView | undefined; harness: string; on: boolean }) =>
      changeQuotaAccess(token, input.daemon, input.harness, input.on),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: xmatrixQueryKeys.domain({ userId }, "machine-daemons", []) });
      onChanged?.();
    },
  });
}

/**
 * A grant harness's quota where it is shown: "Unknown" without a grant, and
 * for the machine's owner the action that allows reading its sign-in, or,
 * once allowed, the one that stops it.
 */
export function HarnessQuotaAccess({ target, token, userId, hasReading = false, bare = false, onChanged }: {
  target: QuotaAccessTarget; token: string; userId: string;
  /** Quota numbers are already shown beside this. */
  hasReading?: boolean;
  /** Only the line, under a heading the caller already wrote. */
  bare?: boolean;
  onChanged?: () => void;
}) {
  const daemons = useOwnerDaemons(token, userId);
  const view = harnessQuotaAccessView({ target, userId, daemons: daemons.data });
  const change = useQuotaAccessChange(token, userId, onChanged);
  const [asking, setAsking] = useState(false);
  if (!view.offered) return null;
  const granted = view.state === "granted";
  if (hasReading && !view.canChange) return null;
  const run = (on: boolean) => change.mutate({ daemon: view.daemon, harness: target.key.harness, on });
  const body = (
    <div className="space-y-2 text-sm" data-testid="harness-quota-access" data-state={view.state ?? "unknown"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!hasReading && <p>
          <span className="font-semibold">Quota: Unknown</span>
          {view.state === "probes_off"
            ? <span className="text-muted-foreground"> · quota probes are off on {target.machineName}</span>
            : !granted && <span className="text-muted-foreground"> · {view.program} has no official quota interface</span>}
        </p>}
        {hasReading && granted && <p className="text-muted-foreground">
          Read from {view.program}&apos;s sign-in on {target.machineName}, which never leaves it.</p>}
        {view.canChange && view.state !== "probes_off" && (granted
          ? <Button size="sm" variant="outline" disabled={change.isPending || Boolean(view.blocker)}
            onClick={() => run(false)}>
            {change.isPending ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : null}Stop reading
          </Button>
          : <Button size="sm" variant="outline" disabled={change.isPending || Boolean(view.blocker)}
            onClick={() => setAsking(true)}>
            {change.isPending ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <KeyRound />}
            Allow reading {view.program} sign-in to show quota
          </Button>)}
      </div>
      {view.canChange && view.blocker && <p className="text-xs text-muted-foreground">{view.blocker}</p>}
      {change.isError && <p role="status" className={noticeClass("alert", "rounded-lg p-3")}>
        {userErrorMessage(change.error, "Couldn't send that to the machine")}</p>}
      {asking && <QuotaAccessConsent program={view.program} machineName={target.machineName} busy={change.isPending}
        onAnswer={(allow) => { setAsking(false); if (allow) run(true); }} />}
    </div>
  );
  return bare ? body : <ToolDetailSection title="Usage">{body}</ToolDetailSection>;
}

/** Settings → Legal and privacy: every machine of the person's where xMatrix
 * reads a harness's sign-in for its quota, each with its stop. */
export function QuotaAccessSettings({ token, userId }: { token: string; userId: string }) {
  const daemons = useOwnerDaemons(token, userId);
  const change = useQuotaAccessChange(token, userId);
  const granted = (daemons.data ?? []).filter((daemon) => daemon.userId === userId).flatMap((daemon) =>
    (parseHarnessInventory(daemon.metadata.harnesses)?.items ?? [])
      .filter((item) => item.quotaAccess === "granted")
      .map((item) => ({ daemon, harness: item.id,
        program: agentPresetById(item.id)?.displayName ?? item.id,
        machineName: daemon.machineName ?? daemon.name })));
  return (
    <ToolDetailSection title="Reading sign-ins for quota">
      <div className="space-y-2 text-sm" data-testid="quota-access-settings">
        <p className="text-muted-foreground">
          Some agent programs have no official way to ask for their quota. xMatrix reads such a program&apos;s
          sign-in only on a computer where you allowed it, only to ask that program for its own usage, and nothing
          from the sign-in leaves that computer.
        </p>
        {granted.length === 0
          ? <p>Not allowed on any of your computers.</p>
          : <ul className="app-tool-lines">
            {granted.map((row) => (
              <li key={`${row.daemon.id}:${row.harness}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>{row.program} on {row.machineName}</span>
                <Button size="sm" variant="outline" disabled={change.isPending || row.daemon.status !== "online"}
                  title={row.daemon.status !== "online" ? "Connect this machine to stop it from here" : undefined}
                  onClick={() => change.mutate({ daemon: row.daemon, harness: row.harness, on: false })}>Stop reading</Button>
              </li>
            ))}
          </ul>}
        {change.isError && <p role="status" className={noticeClass("alert", "rounded-lg p-3")}>
          {userErrorMessage(change.error, "Couldn't send that to the machine")}</p>}
        <p className="text-xs text-muted-foreground">On the computer itself: <code>xmatrix config quotaAccess cursor off</code></p>
      </div>
    </ToolDetailSection>
  );
}
