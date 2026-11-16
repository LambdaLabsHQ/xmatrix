import { harnessProfileSummary, type AgentCapabilitySummary } from "@xmatrix/protocol";
import { machineLabelText, ownerLabelText } from "./agent-identity-format";
import type { MentionCandidate } from "./mention-complete";
import { registrationStatus } from "./my-agents-registrations";

/** Capability entries are unique by harness. A location is an explicit second
 * choice, never a legacy Profile selected by its label. */
export function registrationMentionCandidates(existing: readonly MentionCandidate[],
  capabilities: readonly AgentCapabilitySummary[], query: string): MentionCandidate[] {
  const slash = query.indexOf("/");
  if (slash >= 0) {
    const group = capabilities.find(item => item.harness.toLowerCase() === query.slice(0, slash).toLowerCase());
    if (group) {
      const filter = query.slice(slash + 1).toLocaleLowerCase();
      return group.locations.filter(location => location.state === "enabled" && location.routingReady &&
        `${location.ownerName} ${location.machineName} ${location.displayName}`.toLocaleLowerCase().includes(filter))
        .map(location => {
          const offline = location.live?.machine.online === false;
          const name = `${ownerLabelText(location.ownerName)} · ${machineLabelText(location.machineName)}`;
          // A harness row and its locations show that harness's face.
          return { id: `registration-location:${JSON.stringify(location.key)}`,
            name, kind: "agent" as const, status: "offline" as const,
            mention: group.harness, completionSuffix: " " as const, description: offline ? "Offline" : location.displayName,
            ...(offline ? { unavailable: "Offline" } : {}), face: { kind: "agent" as const, name, harness: group.harness },
            invocationTarget: { kind: "registration" as const, key: location.key } };
        });
    }
  }
  // A harness enabled in the Space but with no location ready to take work is
  // still listed, unselectable, with why: hidden, nobody could tell it apart
  // from one that was never added (2026-11-16, antigravity's model).
  // One its owner turned off on its machine is meant to be away, and is not listed.
  const groups = capabilities.filter(group => group.harness.toLowerCase().includes(query.toLowerCase()) &&
    group.locations.some(location => location.state === "enabled" && location.routingBlocker !== "owner_environment_disabled"));
  return [...groups.map<MentionCandidate>(group => {
    const profile = harnessProfileSummary(group.locations.find(location => location.profile?.description)?.profile?.description ?? "");
    const ready = group.locations.some(location => location.state === "enabled" && location.routingReady);
    const blocked = ready ? undefined : registrationStatus(group.locations.find(location => location.state === "enabled" &&
      location.routingBlocker !== "owner_environment_disabled")!);
    return { id: `capability:${group.harness}`, name: group.harness,
      kind: "agent", status: "offline", mention: group.harness, completionSuffix: " ",
      face: { kind: "agent", name: group.harness, harness: group.harness },
      ...(ready ? {} : { unavailable: blocked?.label ?? "Not ready" }),
      // The row says what the Space wrote the harness is good at, and nothing in its place.
      ...(profile ? { description: profile } : {}),
      profileInvite: !profile && group.locations.some(location => location.canDescribe === true),
      invocationTarget: { kind: "capability", harness: group.harness },
      // Not ready, the row says why in place of what it is good at.
      ...(ready ? {} : { description: blocked?.label ?? "Not ready", profileInvite: false }) };
  }),
  ...existing.filter(candidate => !(candidate.kind === "agent" && !candidate.action && candidate.completionSuffix === ":"))];
}
