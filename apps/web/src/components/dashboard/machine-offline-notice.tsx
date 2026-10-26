"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import type { AgentRegistrationSummary, OfflineMachine } from "@xmatrix/protocol";
import { actionClass } from "@/components/ui/action-tone";
import { useOnboardingLocale } from "@/lib/onboarding-locale";
import { PROBLEM_COPY } from "@/lib/problem-copy";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { useOpenMachine } from "./machine-link";
import { ProblemCard, ProblemCommand } from "./problem-card";

/** How often an open card asks whether the machine is back, and for how long. */
const RECHECK_MS = 10_000;
const RECHECK_FOR_MS = 30 * 60_000;
const BRING_BACK_COMMAND = "xmatrix setup daemon";

/** What the reader's catalog says about one offline machine, for display only. */
function machineState(registrations: readonly AgentRegistrationSummary[], machine: OfflineMachine) {
  const rows = registrations.filter((row) => row.key.machineId === machine.machineId);
  const owners = new Set(rows.map((row) => row.key.ownerUserId));
  const live = rows.map((row) => row.live?.machine).filter((value) => value !== undefined);
  return {
    name: machine.machineName ?? (rows.length && owners.size === 1 ? rows[0].machineName.trim() || undefined : undefined),
    ownerUserId: owners.size === 1 ? [...owners][0] : undefined,
    known: live.length > 0,
    online: live.some((value) => value.online),
    lastSeenAt: live.map((value) => value.lastSeenAt).filter(Boolean).sort().at(-1),
    platform: live.map((value) => value.platform).find(Boolean),
  };
}

/* A summon refused because the computer its agent runs on is offline
   (MACHINE_OFFLINE_NOTICE_KIND): which computer, how its owner brings it
   back, whether it is back yet, and the summon to send again once it is. */
export function MachineOfflineNotice({ offline, sourceMention, spaceId, token, userId, onResend }: {
  offline: readonly OfflineMachine[];
  /** The refused summon as written, `@zcode repo:…`. */
  sourceMention?: string;
  spaceId: string | null; token: string | null; userId: string;
  /** Sends the refused summon again; false when this viewer cannot. Absent when the viewer did not write it. */
  onResend?: () => Promise<boolean>;
}) {
  const locale = useOnboardingLocale(spaceId, token, userId);
  const copy = PROBLEM_COPY[locale];
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", Boolean(spaceId && token));
  const machines = offline.map((machine) => machineState(catalog.data?.registrations ?? [], machine));
  const primary = machines[0];
  const back = machines.some((machine) => machine.online);
  const mine = machines.some((machine) => machine.ownerUserId === userId) || !machines.some((machine) => machine.ownerUserId);
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  const [resend, setResend] = useState<"sending" | "sent" | "failed" | null>(null);
  const { refetch } = catalog;
  useEffect(() => {
    if (back || !spaceId || !token) return;
    const timer = window.setInterval(() => {
      if (Date.now() - mountedAt > RECHECK_FOR_MS) { window.clearInterval(timer); return; }
      setNow(Date.now());
      void refetch();
    }, RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [back, mountedAt, refetch, spaceId, token]);
  const openMachine = useOpenMachine(primary ? { machineId: offline[0].machineId, ...(primary.ownerUserId ? { ownerUserId: primary.ownerUserId } : {}) } : undefined);
  const names = machines.map((machine) => machine.name).filter((name): name is string => Boolean(name));
  const title = names.length > 1 ? names.join(locale === "zh" ? "、" : ", ") : names[0];
  const mention = sourceMention?.split(/\s/u)[0] || "@agent";
  const terminal = primary?.platform === "macos" || primary?.platform === "linux";
  const steps = mine ? [
    copy.machineOffline.powerOn(title),
    terminal ? <>{copy.machineOffline.openAppOrRun}{" "}
      <ProblemCommand command={BRING_BACK_COMMAND} copyLabel={copy.copy} copiedLabel={copy.copied} /></> : copy.machineOffline.openApp,
    copy.machineOffline.sendAgain,
  ] : [];
  const anyKnown = machines.some((machine) => machine.known);
  return (
    <ProblemCard icon={<WifiOff className="size-[18px]" />}
      title={copy.machineOffline.title(title)}
      explanation={<>{copy.machineOffline.explanation(mention)}{mine ? null : <> {copy.machineOffline.someoneElses}</>}</>}
      stepsLabel={copy.machineOffline.stepsLabel} steps={steps}
      {...(anyKnown ? { status: back ? { resolved: true, label: copy.machineOffline.online(title) }
        : { resolved: false, label: copy.machineOffline.offline(copy.relativeTime(primary?.lastSeenAt, now)) } } : {})}
      actions={(onResend || openMachine) ? <>
        {onResend && resend !== "sent" && <button type="button" className={actionClass({ variant: back ? "primary" : "secondary", size: "sm" })}
          disabled={resend === "sending" || (anyKnown && !back)}
          title={anyKnown && !back ? copy.machineOffline.waiting : undefined}
          onClick={() => {
            setResend("sending");
            void onResend().then((sent) => setResend(sent ? "sent" : "failed"), () => setResend("failed"));
          }}>{resend === "sending" ? copy.sending : copy.sendAgain}</button>}
        {openMachine && <button type="button" className={actionClass({ variant: "secondary", size: "sm" })} onClick={openMachine}>
          {copy.openMachine}</button>}
        {resend === "sent" && <span role="status" className="text-[13px] text-muted-foreground">{copy.resent}</span>}
        {resend === "failed" && <span role="status" className="text-[13px] text-destructive">{copy.resendFailed}</span>}
      </> : undefined}
      detailsLabel={copy.detailsLabel}
      details={<p>{copy.errorCode("registration_daemon_offline")}</p>} />
  );
}
