import { agentAvatarUrlFromMetadata, type AgentCapabilitySummary } from "@xmatrix/protocol";
import { machineLabelText, ownerLabelText } from "./agent-identity-format";
import type { MentionCandidate } from "./mention-complete";

/** Capability entries are unique by harness. A location is an explicit second
 * choice, never a legacy Profile selected by its label. */
export function registrationMentionCandidates(existing: readonly MentionCandidate[],
  capabilities: readonly AgentCapabilitySummary[], query: string): MentionCandidate[] {
  // A harness row and its locations show that harness's preset icon.
  const icon = (harness: string) => agentAvatarUrlFromMetadata({ presetId: harness }, harness);
  const slash = query.indexOf("/");
  if (slash >= 0) {
    const group = capabilities.find(item => item.harness.toLowerCase() === query.slice(0, slash).toLowerCase());
    if (group) {
      const filter = query.slice(slash + 1).toLocaleLowerCase();
      return group.locations.filter(location => location.state === "enabled" && location.routingReady &&
        `${location.ownerName} ${location.machineName} ${location.displayName}`.toLocaleLowerCase().includes(filter))
        .map(location => {
          const offline = location.live?.machine.online === false;
          return { id: `registration-location:${JSON.stringify(location.key)}`,
            name: `${ownerLabelText(location.ownerName)} · ${machineLabelText(location.machineName)}`, kind: "agent" as const, status: "offline" as const,
            mention: group.harness, completionSuffix: " " as const, description: offline ? "Offline" : location.displayName,
            ...(offline ? { unavailable: "Offline" } : {}), avatarUrl: icon(group.harness),
            invocationTarget: { kind: "registration" as const, key: location.key } };
        });
    }
  }
  const groups = capabilities.filter(group => group.harness.toLowerCase().includes(query.toLowerCase()) &&
    group.locations.some(location => location.state === "enabled" && location.routingReady));
  return [...groups.map<MentionCandidate>(group => ({ id: `capability:${group.harness}`, name: group.harness,
    kind: "agent", status: "offline", mention: group.harness, completionSuffix: " ", avatarUrl: icon(group.harness),
    description: `Choose automatically · @${group.harness}/ to choose a location`,
    invocationTarget: { kind: "capability", harness: group.harness } })),
  ...existing.filter(candidate => !(candidate.kind === "agent" && !candidate.action && candidate.completionSuffix === ":"))];
}
