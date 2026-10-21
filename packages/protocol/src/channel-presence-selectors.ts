import type { ChannelAgentMemberPresence, ChannelMemberPresence } from "./authority-runtime.js";
import { presenceInstanceId, type AgentInstancePresence, type HumanPresence, type ChannelSnapshot } from "./channel-presence.js";

const agentViews = new WeakMap<AgentInstancePresence, ChannelAgentMemberPresence>();
const humanViews = new WeakMap<HumanPresence, ChannelMemberPresence>();

/** Read-only display adapter; no member-keyed state is stored internally. */
export function agentInstanceMemberPresence(instance: AgentInstancePresence): ChannelAgentMemberPresence {
  const cached = agentViews.get(instance);
  if (cached) return cached;
  const { agentName, registration, email, ...value } = instance;
  // Its face is drawn from `registration.harness` (faces.ts); the view carries no picture.
  const view: ChannelAgentMemberPresence = { kind: "agent", label: agentName, registration, email,
    lastSeenAt: instance.lastSeenAt, activity: instance.activity, files: instance.files,
    intent: instance.intent, runtimeState: instance.runtimeState, goal: instance.goal,
    usage: instance.usage, instances: [value] };
  agentViews.set(instance, view);
  return view;
}

export function channelPresenceMember(channel: Pick<ChannelSnapshot, "presence">,
  member: string): ChannelMemberPresence | undefined {
  const human = channel.presence?.humans.get(member);
  if (human) {
    const cached = humanViews.get(human);
    if (cached) return cached;
    const { devices, ...value } = human;
    const view: ChannelMemberPresence = { ...value, kind: "user", instances: devices.map(device => ({ ...device })) };
    humanViews.set(human, view);
    return view;
  }
  if (!member) return undefined;
  const instance = channel.presence?.instances.get(presenceInstanceId(member));
  return instance ? agentInstanceMemberPresence(instance) : undefined;
}
