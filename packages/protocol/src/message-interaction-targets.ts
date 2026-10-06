import { MESSAGE_INTERACTION_LIMITS } from "./message-interaction-grammar.js";
import { MessageInteractionRegistry } from "./message-interaction-registry.js";
import type {
  InteractionExecutionContract, InteractionOperationDescriptor, InteractionPresentationRef, InteractionTargetDescriptor,
} from "./message-interaction.js";

/**
 * Domain projections into interaction targets. Each is a description of what
 * an address can do, never an access grant: the Hub re-checks every
 * invocation in its owning domain. Clients and the Hub build the same
 * descriptors, so a composer offers exactly the operations the grammar and
 * the registry accept.
 */
function operation(id: string, syntaxRefs: readonly string[], inputSchemaRef: string,
  executionContract: InteractionExecutionContract, presentationRef: InteractionPresentationRef): InteractionOperationDescriptor {
  return { id, syntaxRefs, inputSchemaRef, executionContract, presentationRef };
}

const MENTION = operation("mention", ["address.v1"], "none.v1", "attention.v1", "mention.v1");
const LAUNCH = operation("launch", ["launch.address.v1", "launch-conditions.v1"], "message-body.v1",
  "registration-launch.v1", "launch.v1");
const AGENT_OPERATIONS = Object.freeze([
  MENTION, LAUNCH,
  operation("model", ["runtime.model.v1"], "runtime-model.v1", "runtime-control.v1", "runtime-control.v1"),
  operation("effort", ["runtime.effort.v1"], "runtime-effort.v1", "runtime-control.v1", "runtime-control.v1"),
  operation("handoff", ["lifecycle.handoff.v1"], "handoff-successor.v1", "runtime-lifecycle.v1", "handoff.v1"),
  operation("reborn", ["lifecycle.reborn.v1"], "none.v1", "runtime-lifecycle.v1", "reborn.v1"),
  operation("stop", ["lifecycle.stop.v1"], "stop-reason.v1", "runtime-lifecycle.v1", "stop.v1"),
]);

/** A person in the conversation: addressing them asks for their attention. */
export function humanInteractionTarget(id: string, aliases: readonly string[]): InteractionTargetDescriptor {
  return { schemaVersion: 1, descriptorRevision: "1", targetId: `human:${id}`, kind: "human",
    aliases: [...new Set(aliases.filter(Boolean))], operations: [MENTION] };
}

/** An Agent of the conversation: summoned, steered and handed on through its Instances. */
export function agentInteractionTarget(id: string, alias: string): InteractionTargetDescriptor {
  return { schemaVersion: 1, descriptorRevision: "1", targetId: `agent:${id}`, kind: "agent",
    aliases: [alias], operations: AGENT_OPERATIONS };
}

/** The Space's management service, launched through Jev. */
export function managementInteractionTarget(alias = "xMatrix"): InteractionTargetDescriptor {
  return { schemaVersion: 1, descriptorRevision: "1", targetId: "management:xmatrix", kind: "management",
    aliases: [alias], operations: [LAUNCH] };
}

/** An installed connector and the actions its manifest declares. */
export function connectorInteractionTarget(id: string, actionIds: readonly string[]): InteractionTargetDescriptor {
  const ids = [...new Set(actionIds.map(action => action.trim().toLowerCase()))]
    .filter(action => /^[a-z][a-z0-9_.-]{0,99}$/u.test(action)).slice(0, MESSAGE_INTERACTION_LIMITS.operations);
  return { schemaVersion: 1, descriptorRevision: "1", targetId: `connector:${id}`, kind: "connector",
    aliases: [id], operations: ids.map(action => operation(action, ["connector.action.v1"], "connector-statement.v1",
      "connector-command.v1", "connector.v1")) };
}

/**
 * A registry over the given projections. A projection the registry refuses
 * (a reserved or malformed alias, an operation it does not allow) is left
 * out instead of failing the whole catalog, so one odd member name cannot
 * empty a composer.
 */
export function interactionRegistry(descriptors: readonly InteractionTargetDescriptor[]): MessageInteractionRegistry {
  const accepted: InteractionTargetDescriptor[] = [];
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (accepted.length >= MESSAGE_INTERACTION_LIMITS.targets || seen.has(descriptor.targetId)) continue;
    try { new MessageInteractionRegistry([descriptor]); } catch { continue; }
    seen.add(descriptor.targetId);
    accepted.push(descriptor);
  }
  return new MessageInteractionRegistry(accepted);
}
