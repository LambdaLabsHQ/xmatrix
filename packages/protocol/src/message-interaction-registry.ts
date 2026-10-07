import { interactionGrammarRule, MESSAGE_INTERACTION_LIMITS } from "./message-interaction-grammar.js";
import { canonicalMentionToken, MENTION_BROADCAST_NAMES } from "./mention-address.js";
import type { InteractionOperationDescriptor, InteractionTargetDescriptor, InteractionTargetKind } from "./message-interaction.js";

const RESERVED = new Set([...MENTION_BROADCAST_NAMES, "auto", "xmatrix"]);
const CONTRACTS: Record<InteractionTargetKind, readonly string[]> = {
  human: ["attention.v1"], broadcast: ["attention.v1"],
  agent: ["attention.v1", "registration-launch.v1", "runtime-control.v1", "runtime-lifecycle.v1"],
  instance: ["attention.v1", "registration-launch.v1", "runtime-control.v1", "runtime-lifecycle.v1"],
  router: ["registration-launch.v1"],
  connector: ["connector-command.v1"], service: ["registration-launch.v1"],
};
const EXTRA_SYNTAX = new Set(["address.v1", "launch-conditions.v1", "first-message-choice.v1"]);

function validateDescriptor(target: InteractionTargetDescriptor): void {
  if (target.schemaVersion !== 1 || !target.targetId || target.targetId.length > 200 ||
      !target.descriptorRevision || target.descriptorRevision.length > 200 || !Object.hasOwn(CONTRACTS, target.kind) ||
      !target.aliases.length || target.aliases.length > 32 || target.operations.length > MESSAGE_INTERACTION_LIMITS.operations) {
    throw new Error("Invalid interaction target descriptor");
  }
  const ids = new Set<string>();
  for (const alias of target.aliases) {
    const token = canonicalMentionToken(alias);
    // A person is addressed by display name, which may hold single spaces;
    // every other target's alias is one word.
    const spacing = target.kind === "human" ? /[^\S ]| {2}/u : /\s/u;
    if (!token || token.length > 128 || /[@＠]/u.test(token) || spacing.test(token) ||
        [...token].some(character => character.charCodeAt(0) < 32)) throw new Error("Invalid interaction alias");
    if (RESERVED.has(token) && !((target.kind === "broadcast" && MENTION_BROADCAST_NAMES.includes(token)) ||
        (target.kind === "router" && token === "auto"))) {
      throw new Error("Reserved interaction alias");
    }
  }
  for (const operation of target.operations) {
    if (!/^[a-z][a-z0-9_.-]{0,99}$/u.test(operation.id) || ids.has(operation.id) ||
        !CONTRACTS[target.kind].includes(operation.executionContract) ||
        !operation.syntaxRefs.length || operation.syntaxRefs.length > 8 ||
        !operation.inputSchemaRef || operation.inputSchemaRef.length > 128 ||
        !/^[a-z][a-z0-9.-]{0,79}\.v1$/u.test(operation.presentationRef) ||
        operation.syntaxRefs.some(ref => !EXTRA_SYNTAX.has(ref) && !interactionGrammarRule(ref))) {
      throw new Error("Invalid interaction operation descriptor");
    }
    ids.add(operation.id);
  }
}

export type InteractionTargetResolution =
  | { status: "resolved"; target: InteractionTargetDescriptor; operation: InteractionOperationDescriptor }
  | { status: "unknown" | "ambiguous" | "unsupported" };

/** Per-request catalog built from permission-filtered domain projections. No
 * mutable global registration and no first-match wins on an ambiguous name. */
export class MessageInteractionRegistry {
  private readonly targets: Map<string, InteractionTargetDescriptor>;
  private readonly names = new Map<string, Set<string>>();

  constructor(descriptors: readonly InteractionTargetDescriptor[]) {
    if (descriptors.length > MESSAGE_INTERACTION_LIMITS.targets) throw new Error("Too many interaction targets");
    this.targets = new Map();
    for (const descriptor of descriptors) {
      validateDescriptor(descriptor);
      if (this.targets.has(descriptor.targetId)) throw new Error("Duplicate interaction target");
      const copy = structuredClone(descriptor);
      this.targets.set(copy.targetId, copy);
      for (const alias of copy.aliases) {
        const token = canonicalMentionToken(alias);
        const ids = this.names.get(token) ?? new Set<string>();
        ids.add(copy.targetId);
        this.names.set(token, ids);
      }
    }
  }

  descriptors(): InteractionTargetDescriptor[] { return structuredClone([...this.targets.values()]); }
  aliases(): string[] { return [...this.names.keys()]; }

  resolve(alias: string, operationId: string): InteractionTargetResolution {
    const ids = this.names.get(canonicalMentionToken(alias));
    if (!ids?.size) return { status: "unknown" };
    if (ids.size !== 1) return { status: "ambiguous" };
    const target = this.targets.get([...ids][0]!)!;
    const operation = target.operations.find(candidate => candidate.id === operationId);
    return operation ? { status: "resolved", target: structuredClone(target), operation: structuredClone(operation) }
      : { status: "unsupported" };
  }
}
