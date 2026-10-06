import type { AgentRegistrationSummary } from "@xmatrix/protocol";
import type { StatusTone } from "@/components/ui/status-tone";
import { formatRelativeAge } from "./time-display";

/** What a viewer may do to one registration on My Agents. */
export type MyAgentAction = "configure" | "restore";

export const MY_AGENT_ACTION_LABEL: Record<MyAgentAction, string> = {
  configure: "Configure",
  restore: "Add back to Space",
};

/** A registration removed from the Space is gone from its list. Only the
 * owner, who alone can add it back, still sees it, with that action. */
export function registrationListed(registration: AgentRegistrationSummary): boolean {
  return registration.state !== "revoked" || registrationActions(registration).includes("restore");
}

/** A ready registration is the resting state and carries no chip. */
export function registrationStatus(registration: AgentRegistrationSummary): { label: string; tone: StatusTone } | null {
  if (registration.state === "revoked") return { label: "Removed", tone: "secondary" };
  if (registration.state === "unshared") return { label: "Not shared with this Space", tone: "secondary" };
  if (registration.state === "disabled") return { label: "Disabled", tone: "secondary" };
  switch (registration.routingBlocker) {
    case "owner_environment_missing": return { label: "Not set up on its machine", tone: "alert" };
    case "owner_environment_disabled": return { label: "Disabled", tone: "secondary" };
    case "model_unavailable": return { label: "No model available", tone: "alert" };
    case "space_setup": return { label: "Needs Space setup", tone: "attention" };
    default: return registration.routingReady ? null : { label: "Not ready", tone: "attention" };
  }
}

/** A quota at or under this share is worth a glance before summoning. */
const QUOTA_NOTICE_PERCENT = 20;

/**
 * What one location is doing now, for its row and its page: a line saying
 * what it does or why it cannot take work, the state its mark shows at a
 * glance, and a rank that puts working locations first and absent ones last.
 */
export interface RegistrationActivity {
  state: "running" | "paused" | "attention" | "offline";
  line: string;
  rank: number;
}

export function registrationActivity(registration: AgentRegistrationSummary, options: {
  /** A Channel's title, for the ones the reader has; running elsewhere reads as "a conversation". */
  conversationTitle: (channelId: string) => string | undefined;
  now?: number;
}): RegistrationActivity {
  const status = registrationStatus(registration);
  const live = registration.live;
  if (registration.state !== "enabled" || registration.routingBlocker === "owner_environment_disabled") {
    return { state: "paused", line: status?.label ?? "Unavailable", rank: 4 };
  }
  if (live && !live.machine.online) {
    const seen = formatRelativeAge(live.machine.lastSeenAt, options.now);
    return { state: "offline", line: seen ? `Offline · seen ${seen}` : "Offline", rank: 3 };
  }
  if (status) return { state: "attention", line: status.label, rank: 2 };
  const quota = live?.quota;
  if (quota && quota.remainingPercent < 1) return { state: "attention", line: "Out of quota", rank: 2 };
  const quotaNote = quota && quota.remainingPercent <= QUOTA_NOTICE_PERCENT
    ? ` · ${Math.round(quota.remainingPercent)}% quota left` : "";
  const running = live?.running ?? [];
  if (running.length) {
    const places = [...new Set(running.map((instance) => {
      const title = options.conversationTitle(instance.channelId);
      return title ? `#${title}` : "a conversation";
    }))];
    const lead = running.length === 1 ? "Running" : `${running.length} running`;
    return { state: "running", line: `${lead} in ${places.join(", ")}${quotaNote}`, rank: 0 };
  }
  return { state: "running", line: `Ready${quotaNote}`, rank: 1 };
}

/**
 * A row names what differs between a runtime's locations. With the default
 * name that is the machine; a name the Space gave it is the name people call
 * it by, and then the machine leads the line under it.
 */
export function registrationRowTitle(registration: AgentRegistrationSummary): { title: string; machineInLine: boolean } {
  const named = registration.displayName.trim();
  return named && named.toLowerCase() !== registration.key.harness.toLowerCase()
    ? { title: named, machineInLine: true }
    : { title: registration.machineName, machineInLine: false };
}

/** Why the registration catalog could not be read: the server's message plus
 * its error code, so a failure is diagnosable instead of an empty list. */
export function registrationCatalogErrorText(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : "The agent list could not be loaded.";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code && code !== "request_failed" && !message.includes(code)
    ? `${message} (${code})` : message;
}

/** Space owners/admins configure an agent; an agent removed from the Space
 * before switches existed is added back by its owner. */
export function registrationActions(registration: AgentRegistrationSummary): MyAgentAction[] {
  const granted = registration.state === "enabled" || registration.state === "disabled";
  const actions: MyAgentAction[] = [];
  if (registration.canConfigureSpace && granted) actions.push("configure");
  if (registration.canManageOwnerGrant && registration.state === "revoked") actions.push("restore");
  return actions;
}

/** The agent's one on/off switch in this Space, for a Space owner/admin and
 * for the agent's owner. Off stops its running work here and takes no new
 * work; on lets it work again. `changes` are the commands that reach the
 * other position: an agent its owner turned off on its machine (before the
 * switch was per Space) is turned on there too. */
export interface RegistrationSwitch {
  on: boolean;
  changes: Array<"space-disable" | "space-enable" | "enable">;
}

export function registrationSwitch(registration: AgentRegistrationSummary): RegistrationSwitch | null {
  const granted = registration.state === "enabled" || registration.state === "disabled";
  if (!granted || !(registration.canConfigureSpace || registration.canManageOwnerGrant)) return null;
  const machineOff = registration.routingBlocker === "owner_environment_disabled";
  const on = registration.state === "enabled" && !machineOff;
  if (on) return { on, changes: ["space-disable"] };
  return { on, changes: [
    ...(registration.state === "disabled" ? ["space-enable" as const] : []),
    ...(machineOff && registration.canManageOwnerGrant ? ["enable" as const] : []),
  ] };
}
