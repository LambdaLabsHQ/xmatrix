import { currentRoutingQuotaWindows, type AgentRegistrationSummary } from "@xmatrix/protocol";
import type { StatusTone } from "@/components/ui/status-tone";
import { formatRelativeAge } from "./time-display";

/** What a viewer may do to one registration on My Agents. */
export type MyAgentAction = "restore";

export const MY_AGENT_ACTION_LABEL: Record<MyAgentAction, string> = {
  restore: "Add back to Space",
};

/** How this viewer reads one registration's Space settings: edited in place by
 * Space owners and admins while the agent is in the Space, read-only for its
 * owner or once removed, and absent for ordinary members (the Hub omits them). */
export function registrationSettingsMode(registration: AgentRegistrationSummary): "edit" | "read" | "none" {
  const granted = registration.state === "enabled" || registration.state === "disabled";
  if (registration.canConfigureSpace && granted) return "edit";
  if (registration.canConfigureSpace || registration.canManageOwnerGrant) return "read";
  return "none";
}

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
  /** The line without its quota note, for a row that draws the quota itself. */
  brief: string;
  rank: number;
  /** How many of its Instances have work in hand. */
  working: number;
}

export function registrationActivity(registration: AgentRegistrationSummary, options: {
  /** A Channel's title, for the ones the reader has; work elsewhere reads as "a conversation". */
  conversationTitle: (channelId: string) => string | undefined;
  now?: number;
  /**
   * The Instances with work in hand. A live process waiting for its next
   * message runs but does not work: only the ones at work are counted and
   * named, and a location with none reads as ready.
   */
  working: ReadonlySet<string>;
}): RegistrationActivity {
  const say = (state: RegistrationActivity["state"], line: string, rank: number): RegistrationActivity =>
    ({ state, line, brief: line, rank, working: 0 });
  const status = registrationStatus(registration);
  const live = registration.live;
  if (registration.state !== "enabled" || registration.routingBlocker === "owner_environment_disabled") {
    return say("paused", status?.label ?? "Unavailable", 4);
  }
  if (live && !live.machine.online) {
    const seen = formatRelativeAge(live.machine.lastSeenAt, options.now);
    return say("offline", seen ? `Offline · seen ${seen}` : "Offline", 3);
  }
  if (status) return say("attention", status.label, 2);
  // A prepaid account the provider refuses, or with no money left, cannot take work.
  if (live?.balance && (live.balance.allowed === false || live.balance.amount <= 0)) return say("attention", "Out of balance", 2);
  const quota = live?.quota;
  if (quota && quota.remainingPercent < 1) {
    const windows = currentRoutingQuotaWindows(quota.windows, options.now ?? Date.now());
    const labels = [...new Set(windows.filter(window => window.usedPercent > 99)
      .flatMap(window => window.label ? [window.label] : []))];
    return say("attention", labels.length ? `${labels.join(" + ")} limit reached` : "Out of quota · window unavailable", 2);
  }
  const quotaNote = quota && quota.remainingPercent <= QUOTA_NOTICE_PERCENT
    ? ` · ${Math.round(quota.remainingPercent)}% quota left` : "";
  const working = (live?.running ?? []).filter((instance) => options.working.has(instance.instanceId));
  if (working.length) {
    const places = [...new Set(working.map((instance) => {
      const title = options.conversationTitle(instance.channelId);
      return title ? `#${title}` : "a conversation";
    }))];
    const brief = `${working.length === 1 ? "Working" : `${working.length} working`} in ${places.join(", ")}`;
    return { state: "running", line: `${brief}${quotaNote}`, brief, rank: 0, working: working.length };
  }
  return { state: "running", line: `Ready${quotaNote}`, brief: "Ready", rank: 1, working: 0 };
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

/** An agent removed from the Space before switches existed is added back by its owner. */
export function registrationActions(registration: AgentRegistrationSummary): MyAgentAction[] {
  return registration.canManageOwnerGrant && registration.state === "revoked" ? ["restore"] : [];
}

/** The agent's one on/off switch in this Space, for a Space owner/admin and
 * for the agent's owner. Off stops its running work here and takes no new
 * work; on lets it work again. `changes` are the commands that reach the
 * other position: an agent its owner turned off on its machine (from a card
 * about its program there, `machineSwitch`, or before the switch was per
 * Space) is turned on there too. */
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

/** The owner's switch for an agent on its machine, in every Space, as a card
 * about the program there reads it: whether it is off, and whether there is
 * one for this viewer to turn off (their own agent, on in this Space and set
 * up on its machine). Only its owner holds it. */
export function machineSwitch(registration: AgentRegistrationSummary | undefined, userId: string): { off: boolean; canTurnOff: boolean } {
  if (!registration || registration.key.ownerUserId !== userId) return { off: false, canTurnOff: false };
  const off = registration.routingBlocker === "owner_environment_disabled";
  return { off, canTurnOff: !off && registration.state === "enabled" && registration.routingBlocker !== "owner_environment_missing" };
}

/** The models the Default model menu offers: what the runtime's catalog lists,
 * then any declared model it does not, then the saved value when neither names
 * it, so a saved choice is never dropped from its own menu. */
export function registrationModelChoices(registration: AgentRegistrationSummary,
  saved: string): Array<{ model: string; description?: string }> {
  const choices = new Map<string, { model: string; description?: string }>();
  for (const option of registration.modelCatalog ?? []) {
    const model = option.model.trim();
    if (model && !choices.has(model)) choices.set(model, { model, ...(option.description ? { description: option.description } : {}) });
  }
  for (const model of [...registration.models, saved].map(name => name.trim())) {
    if (model && !choices.has(model)) choices.set(model, { model });
  }
  return [...choices.values()];
}
