import type { SerializedAgent, SerializedChannel } from "@xmatrix/protocol";
import {
  agentInstanceMentionLabel,
  channelAgentInstances,
  channelAgents,
  instanceCommandOptions,
  isLocalAgentCandidate,
  mentionLocalMachineKeys,
  mentionStatusRank,
  type InstanceCommandOption,
  type MentionCandidate,
  type MentionLocalContext,
} from "./mention-complete";

/**
 * Slash-first command completion.
 *
 * `@instance /command` already exists and is what the Hub parses; this module
 * only offers the same grammar in the order a coding-agent user types it —
 * command first, target second. Nothing here invents wire syntax: every
 * completion produces exactly the `@instance /command ` text the mention path
 * would have produced, so the Hub, CLI, and runtimes stay untouched.
 *
 * The palette opens only when the draft *starts* with `/`. That is the rule
 * every chat client already trains: a slash mid-sentence is a slash, and
 * `@claude:1 /model` keeps belonging to the mention stage that owns it.
 */

/** `/mod` — choosing which command to run. */
const SLASH_COMMAND_QUERY_RE = /^\s*\/([^\s@]*)$/;
/** `/model @cl` — the command is chosen, now choosing which instance runs it. */
const SLASH_TARGET_QUERY_RE = /^\s*\/(\S+)\s+@(\S*)$/;

export type SlashCompletionStage = "command" | "target";

export type ActiveSlashCommand = {
  /** Index of the leading `/`. */
  start: number;
  /** The caret, which is where the typed query ends. */
  end: number;
  /**
   * End of the whole slash expression, which is past the caret whenever the
   * human typed in front of text that was already there. Completion replaces up
   * to here so no orphan tail is left behind.
   */
  tokenEnd: number;
  stage: SlashCompletionStage;
  /** The chosen command token including its slash, only in the target stage. */
  token?: string;
  /** What the human has typed in the current stage. */
  query: string;
};

export type SlashCommandTarget = {
  agentId: string;
  instanceId: string;
  /** The mention this target composes to, e.g. `claude-code:1`. */
  mention: string;
  label: string;
  status: SerializedAgent["status"];
  local: boolean;
  avatarUrl?: string;
  email?: string;
};

export type SlashCommandCandidate = {
  /** Normalized command token, unique within one channel's palette. */
  id: string;
  /** Canonical command token including the leading slash. */
  token: string;
  label: string;
  description?: string;
  action?: MentionCandidate["action"];
  /** Every live instance in this channel that accepts this command. */
  targets: SlashCommandTarget[];
};

export type SlashCompletionResult = {
  active: ActiveSlashCommand | null;
  stage: SlashCompletionStage;
  stageLabel: string;
  /** Command rows, in the command stage. */
  commands: SlashCommandCandidate[];
  /** Instance rows, in the target stage. */
  targets: SlashCommandTarget[];
  /** The command the target stage is choosing a runner for. */
  command: SlashCommandCandidate | null;
};

const EMPTY_RESULT: SlashCompletionResult = {
  active: null,
  stage: "command",
  stageLabel: "Agent commands",
  commands: [],
  targets: [],
  command: null,
};

export function normalizeSlashToken(token: string): string {
  return token.trim().replace(/^\/+/, "").toLowerCase();
}

/**
 * The slash expression the caret sits in, or `null` when the draft is not a
 * slash command. Only a draft whose first non-whitespace character is `/`
 * qualifies, so ordinary prose containing a slash never opens the palette.
 */
export function findActiveSlashCommand(
  draft: string,
  cursor: number
): ActiveSlashCommand | null {
  const beforeCursor = draft.slice(0, Math.max(0, cursor));
  const slashIndex = beforeCursor.search(/\S/);
  if (slashIndex < 0 || beforeCursor.charAt(slashIndex) !== "/") return null;

  const targetMatch = beforeCursor.match(SLASH_TARGET_QUERY_RE);
  if (targetMatch) {
    return {
      start: slashIndex,
      end: cursor,
      tokenEnd: slashExpressionEnd(draft, cursor),
      stage: "target",
      token: `/${normalizeSlashToken(targetMatch[1])}`,
      query: targetMatch[2],
    };
  }

  const commandMatch = beforeCursor.match(SLASH_COMMAND_QUERY_RE);
  if (!commandMatch) return null;
  return {
    start: slashIndex,
    end: cursor,
    tokenEnd: slashExpressionEnd(draft, cursor),
    stage: "command",
    query: commandMatch[1],
  };
}

/**
 * Where the slash expression ends, using the same close set as the mention
 * grammar: whitespace or a closing bracket. Equal to the caret when the human
 * is typing at the end of the expression, which is the common case.
 */
function slashExpressionEnd(draft: string, cursor: number): number {
  let end = Math.max(0, cursor);
  while (end < draft.length && !/[\s\]})]/u.test(draft.charAt(end))) end += 1;
  return end;
}

/**
 * Every command any live instance in this channel accepts, deduped by token.
 * A command is one row no matter how many instances advertise it; which of them
 * runs it is the next stage's question.
 */
export function channelSlashCommands(
  channel: SerializedChannel | null,
  localContext?: MentionLocalContext | null
): SlashCommandCandidate[] {
  if (!channel) return [];

  const localMachineKeys = mentionLocalMachineKeys(localContext);
  const byToken = new Map<string, SlashCommandCandidate>();

  for (const agent of channelAgents(channel)) {
    for (const instance of channelAgentInstances(channel, agent)) {
      const target: SlashCommandTarget = {
        agentId: agent.id,
        instanceId: instance.id,
        // Channel slots are unique within a Channel, so `name:slot` is exact.
        mention: agentInstanceMentionLabel(agent.name, instance),
        label: instance.label?.trim() || `Instance ${instance.channelInstanceId || ""}`.trim(),
        status: instance.status,
        local: isLocalAgentCandidate(localMachineKeys, agent, instance),
        avatarUrl: agent.avatarUrl,
        email: agent.email,
      };
      for (const option of instanceCommandOptions(agent, instance)) {
        addSlashCommandTarget(byToken, option, target);
      }
    }
  }

  return Array.from(byToken.values())
    .map((command) => ({ ...command, targets: sortSlashCommandTargets(command.targets) }))
    .sort((left, right) => left.token.localeCompare(right.token));
}

function addSlashCommandTarget(
  byToken: Map<string, SlashCommandCandidate>,
  option: InstanceCommandOption,
  target: SlashCommandTarget
): void {
  const id = normalizeSlashToken(option.token);
  if (!id) return;
  const existing = byToken.get(id);
  if (!existing) {
    byToken.set(id, {
      id,
      token: `/${id}`,
      label: option.label || `/${id}`,
      description: option.description,
      action: option.action,
      targets: [target],
    });
    return;
  }
  /* Two runtimes can advertise the same token with different copy. The first
     one's label already named the row the human is reading, so it stays; only
     the target list grows. */
  if (!existing.targets.some((candidate) => candidate.instanceId === target.instanceId)) {
    existing.targets.push(target);
  }
}

function sortSlashCommandTargets(targets: SlashCommandTarget[]): SlashCommandTarget[] {
  return [...targets].sort((left, right) => {
    if (left.local !== right.local) return left.local ? -1 : 1;
    const statusOrder = mentionStatusRank(left.status) - mentionStatusRank(right.status);
    if (statusOrder !== 0) return statusOrder;
    return left.mention.localeCompare(right.mention);
  });
}

export function filterSlashCommands(
  commands: SlashCommandCandidate[],
  query: string
): SlashCommandCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return commands;
  return commands.filter((command) => {
    const token = command.id;
    return (
      token.startsWith(normalized) ||
      token.includes(normalized) ||
      command.label.toLowerCase().includes(normalized) ||
      (command.description?.toLowerCase().includes(normalized) ?? false)
    );
  });
}

export function filterSlashCommandTargets(
  targets: SlashCommandTarget[],
  query: string
): SlashCommandTarget[] {
  const normalized = query.trim().replace(/^@/, "").toLowerCase();
  if (!normalized) return targets;
  return targets.filter(
    (target) =>
      target.mention.toLowerCase().includes(normalized) ||
      target.label.toLowerCase().includes(normalized) ||
      (target.local && "this machine local".includes(normalized))
  );
}

export function resolveSlashCompletion(
  draft: string,
  cursor: number,
  channel: SerializedChannel | null,
  localContext?: MentionLocalContext | null
): SlashCompletionResult {
  const active = findActiveSlashCommand(draft, cursor);
  if (!active || !channel) return { ...EMPTY_RESULT, active };

  const commands = channelSlashCommands(channel, localContext);
  if (active.stage === "command") {
    return {
      active,
      stage: "command",
      stageLabel: "Agent commands",
      commands: filterSlashCommands(commands, active.query),
      targets: [],
      command: null,
    };
  }

  const command = commands.find((candidate) => candidate.id === normalizeSlashToken(active.token || ""));
  if (!command) {
    /* The token is not a command any live instance here accepts, so there is no
       target to choose. The draft is left alone; it sends as the literal text
       it already is. */
    return { ...EMPTY_RESULT, active, stage: "target", stageLabel: "Agent commands" };
  }
  return {
    active,
    stage: "target",
    stageLabel: `Run ${command.token} on`,
    commands: [],
    targets: filterSlashCommandTargets(command.targets, active.query),
    command,
  };
}

/**
 * Pick a command whose runner is still unknown: keep the slash expression and
 * open the target stage after it.
 *
 * The trailing `@` is what makes the next keystroke a target query rather than
 * damage — `/model` + `c` reads as `/modelc`, which is no command at all, while
 * `/model @` + `c` is a command whose runner is being typed. A human who never
 * picks a target is left with plain text that sends as written.
 */
export function completeSlashCommandToken(
  draft: string,
  cursor: number,
  token: string
): { value: string; cursor: number } {
  const active = findActiveSlashCommand(draft, cursor);
  if (!active) return { value: draft, cursor };
  const insert = `/${normalizeSlashToken(token)} @`;
  const value = `${draft.slice(0, active.start)}${insert}${draft.slice(active.tokenEnd)}`;
  return { value, cursor: active.start + insert.length };
}

/**
 * Commit command and runner together, rewriting the slash expression into the
 * `@instance /command ` text the Hub parses. The caret lands after the trailing
 * space, which is exactly where the existing `@instance /command <arg>` stage
 * takes over — so `/model` picked here still gets its model list next.
 */
export function completeSlashCommandTarget(
  draft: string,
  cursor: number,
  token: string,
  mention: string
): { value: string; cursor: number } {
  const active = findActiveSlashCommand(draft, cursor);
  if (!active) return { value: draft, cursor };
  const suffix = draft.slice(active.tokenEnd);
  const insert = `@${mention} /${normalizeSlashToken(token)}${/^\s/u.test(suffix) ? "" : " "}`;
  const value = `${draft.slice(0, active.start)}${insert}${suffix}`;
  return { value, cursor: active.start + insert.length };
}
