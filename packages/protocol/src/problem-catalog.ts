import { MENTION_ONLY_REJECTION_CODES, preparationFailureSummary } from "./invocation-failure.js";
import type { OnboardingLocale } from "./onboarding-message.js";

/*
 * The words people read when xMatrix refuses or fails something, keyed by the
 * stable code the Hub records beside its text. One table per family, one row
 * per code, every row in each language. The Hub writes the English row into
 * the Channel (CLI and Agent readers); clients render the reader's language
 * from the code, and keep the code itself in Details.
 *
 * Templates name their values as {placeholder}; problem-catalog.test checks
 * that every language of a row uses the same ones, and that every code the
 * Hub can record has a row.
 */

export type ProblemLocale = OnboardingLocale;

/** What happened, what it left behind, and what to do next. */
export interface ProblemWords { title: string; explanation: string; steps: readonly string[] }
export type ProblemRow = Readonly<Record<ProblemLocale, ProblemWords>>;

/** Fill {name} placeholders. A value that is missing stays visible as written. */
export function fillProblemTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/gu, (whole, name: string) => Object.hasOwn(values, name) ? values[name]! : whole);
}

function fill(words: ProblemWords, values: Readonly<Record<string, string>>): ProblemWords {
  return { title: fillProblemTemplate(words.title, values), explanation: fillProblemTemplate(words.explanation, values),
    steps: words.steps.map(step => fillProblemTemplate(step, values)) };
}

/* ---------------------------------------------------------------------------
 * Reborn and handoff refusals: recorded on the `@` that asked for them.
 * Values: {source} the Instance address, {successor} the Agent asked to take
 * over, {other} the handoff to write instead.
 * ------------------------------------------------------------------------- */

const STOPPED_EN = "{source} has stopped and its work is kept, but";
const STOPPED_ZH = "{source} 已经停下，工作都保留着；但";

export const HANDOFF_REFUSALS = {
  registration_quota_exhausted: {
    en: { title: "{successor} couldn't take over {source}: out of quota",
      explanation: `${STOPPED_EN} every {successor} that could continue it has used up its provider quota, so no new Agent started.`,
      steps: ["Hand it to another Agent: send {other}. xMatrix picks one that still has quota.",
        "Or wait until {successor}'s quota resets, then send the same handoff again."] },
    zh: { title: "{successor} 额度用完了，没能接手 {source}",
      explanation: `${STOPPED_ZH}所有能接手的 {successor} 都用完了服务商额度，所以没有新的 Agent 启动。`,
      steps: ["换一个 Agent 接手：发送 {other}，xMatrix 会挑一个还有额度的。", "或者等 {successor} 的额度重置后，再发一次同样的交接。"] },
  },
  no_machine: {
    en: { title: "No machine here can run {successor}",
      explanation: `${STOPPED_EN} none of the machines this conversation can use runs {successor}, so no new Agent started.`,
      steps: ["Hand it to another Agent: send {other}.", "Or connect a machine that runs {successor}, then send the same handoff again."] },
    zh: { title: "这里没有能运行 {successor} 的电脑",
      explanation: `${STOPPED_ZH}这个对话能用的电脑上都没有 {successor}，所以没有新的 Agent 启动。`,
      steps: ["换一个 Agent 接手：发送 {other}。", "或者接入一台装了 {successor} 的电脑，再发一次同样的交接。"] },
  },
  registration_daemon_offline: {
    en: { title: "The computer that runs {successor} is offline",
      explanation: `${STOPPED_EN} xMatrix can't reach the computer {successor} runs on, so no new Agent started.`,
      steps: ["Turn that computer on and open xMatrix there, then send the same handoff again.", "Or hand it to another Agent: send {other}."] },
    zh: { title: "运行 {successor} 的电脑离线了",
      explanation: `${STOPPED_ZH}xMatrix 连不上运行 {successor} 的电脑，所以没有新的 Agent 启动。`,
      steps: ["打开那台电脑并启动 xMatrix，再发一次同样的交接。", "或者换一个 Agent 接手：发送 {other}。"] },
  },
  launch_failed: {
    en: { title: "{successor} didn't start after {source} stopped",
      explanation: `${STOPPED_EN} {successor} could not be started.`,
      steps: ["Hand it to another Agent: send {other}.", "Or send the same handoff again."] },
    zh: { title: "{source} 停下后，{successor} 没有启动",
      explanation: `${STOPPED_ZH}{successor} 没能启动。`,
      steps: ["换一个 Agent 接手：发送 {other}。", "或者再发一次同样的交接。"] },
  },
  handoff_source_stop_pending: {
    en: { title: "{source} is still stopping",
      explanation: "A handoff stops {source} before {successor} starts. Its computer hasn't confirmed the stop yet, so {successor} hasn't started.",
      steps: ["Wait until {source} shows Stopped, then send the same handoff again."] },
    zh: { title: "{source} 还在停止中",
      explanation: "交接会先停下 {source} 再启动 {successor}。它的电脑还没确认已经停下，所以 {successor} 还没启动。",
      steps: ["等 {source} 显示 Stopped 后，再发一次同样的交接。"] },
  },
  handoff_source_stop_unavailable: {
    en: { title: "{source} couldn't be stopped for the handoff",
      explanation: "A handoff stops {source} before {successor} starts, and that stop didn't go through. {source} keeps its work; nothing new started.",
      steps: ["Check that the computer {source} runs on is online, then send the same handoff again."] },
    zh: { title: "没能停下 {source} 来交接",
      explanation: "交接会先停下 {source} 再启动 {successor}，这一步没有成功。{source} 的工作都还在，没有启动新的 Agent。",
      steps: ["确认运行 {source} 的电脑在线，再发一次同样的交接。"] },
  },
  handoff_location_conflict: {
    en: { title: "{successor} has to continue where {source} worked",
      explanation: "A handoff keeps {source}'s repository or directory. This one asked for a different repo: or pwd:, so nothing was stopped or started.",
      steps: ["Remove the repo: or pwd: condition and send the handoff again."] },
    zh: { title: "{successor} 只能在 {source} 原来的位置接着做",
      explanation: "交接会沿用 {source} 的仓库或目录，这次却指定了别的 repo: 或 pwd:，所以什么都没停、什么都没启动。",
      steps: ["去掉 repo: 或 pwd: 条件，再发一次交接。"] },
  },
  handoff_source_not_transferable: {
    en: { title: "{source} can't be handed off",
      explanation: "{source} works for this Space's management or a direct conversation, and stays where it is. Nothing was stopped or started.",
      steps: ["Start {successor} on its own instead."] },
    zh: { title: "{source} 不能交接",
      explanation: "{source} 负责这个 Space 的管理或私聊对话，会一直留在原处。什么都没停、什么都没启动。",
      steps: ["需要的话，直接单独启动 {successor}。"] },
  },
  lifecycle_source_not_found: {
    en: { title: "{source} isn't in this conversation",
      explanation: "xMatrix found no {source} here to hand off. Nothing was stopped or started.",
      steps: ["Check the number after the Agent's name in the member list, then send the handoff again."] },
    zh: { title: "这个对话里没有 {source}",
      explanation: "xMatrix 在这里找不到要交接的 {source}，什么都没停、什么都没启动。",
      steps: ["在成员列表里核对 Agent 名字后面的编号，再发一次交接。"] },
  },
  lifecycle_source_invalid: {
    en: { title: "{source} belongs to another conversation",
      explanation: "A handoff only moves an Agent of this conversation. Nothing was stopped or started.",
      steps: ["Send the handoff in the conversation {source} works in."] },
    zh: { title: "{source} 属于别的对话",
      explanation: "交接只能移交这个对话里的 Agent，什么都没停、什么都没启动。",
      steps: ["到 {source} 所在的对话里发送交接。"] },
  },
  invalid_registration_launch: {
    en: { title: "This handoff couldn't be read", explanation: "Nothing was stopped or started.",
      steps: ["Write it as {source}:handoff:@<agent>, for example {source}:handoff:@auto."] },
    zh: { title: "这条交接没法识别", explanation: "什么都没停、什么都没启动。",
      steps: ["写成 {source}:handoff:@<agent>，比如 {source}:handoff:@auto。"] },
  },
  registration_handoff_failed: {
    en: { title: "{source} wasn't handed off to {successor}",
      explanation: "xMatrix could not finish the handoff.",
      steps: ["Check whether {source} is still running, then send the handoff again, or send {other}."] },
    zh: { title: "{source} 没有交接给 {successor}",
      explanation: "xMatrix 没能完成这次交接。",
      steps: ["先看看 {source} 是否还在运行，再发一次交接，或者发送 {other}。"] },
  },
} as const satisfies Record<string, ProblemRow>;

export const REBORN_REFUSALS = {
  lifecycle_source_not_found: {
    en: { title: "{source} isn't in this conversation",
      explanation: "xMatrix found no {source} here to restart. Nothing was started.",
      steps: ["Check the number after the Agent's name in the member list, then send the reborn again."] },
    zh: { title: "这个对话里没有 {source}",
      explanation: "xMatrix 在这里找不到要重启的 {source}，什么都没有启动。",
      steps: ["在成员列表里核对 Agent 名字后面的编号，再发一次 reborn。"] },
  },
  lifecycle_source_invalid: {
    en: { title: "{source} belongs to another conversation",
      explanation: "A reborn only restarts an Agent of this conversation. Nothing was started.",
      steps: ["Send the reborn in the conversation {source} works in."] },
    zh: { title: "{source} 属于别的对话",
      explanation: "reborn 只能重启这个对话里的 Agent，什么都没有启动。",
      steps: ["到 {source} 所在的对话里发送 reborn。"] },
  },
  reborn_target_lookup_failed: {
    en: { title: "xMatrix couldn't read {source}",
      explanation: "{source} could not be read, or you don't have access to it. Nothing was started.",
      steps: ["Check that you can still see {source} in this conversation, then send the reborn again."] },
    zh: { title: "xMatrix 读不到 {source}",
      explanation: "读取 {source} 失败，或者你没有它的权限，什么都没有启动。",
      steps: ["确认你在这个对话里还能看到 {source}，再发一次 reborn。"] },
  },
  registration_quota_exhausted: {
    en: { title: "{source} can't restart: out of quota",
      explanation: "Every machine that runs {source}'s Agent has used up its provider quota. Nothing was started.",
      steps: ["Wait for the quota to reset, then send the reborn again.", "Or hand the work to another Agent: send {source}:handoff:@auto."] },
    zh: { title: "{source} 额度用完了，没法重启",
      explanation: "能运行 {source} 的电脑都用完了服务商额度，什么都没有启动。",
      steps: ["等额度重置后，再发一次 reborn。", "或者交给别的 Agent：发送 {source}:handoff:@auto。"] },
  },
  registration_daemon_offline: {
    en: { title: "The computer that runs {source} is offline",
      explanation: "xMatrix can't reach the computer {source} runs on. Nothing was started.",
      steps: ["Turn that computer on and open xMatrix there, then send the reborn again.", "Or hand the work to another Agent: send {source}:handoff:@auto."] },
    zh: { title: "运行 {source} 的电脑离线了",
      explanation: "xMatrix 连不上运行 {source} 的电脑，什么都没有启动。",
      steps: ["打开那台电脑并启动 xMatrix，再发一次 reborn。", "或者交给别的 Agent：发送 {source}:handoff:@auto。"] },
  },
  registration_reborn_failed: {
    en: { title: "{source} couldn't be restarted",
      explanation: "xMatrix could not prepare the restart. Nothing was started.",
      steps: ["Check that {source}'s Agent is still connected to this Space, then send the reborn again."] },
    zh: { title: "{source} 没能重启",
      explanation: "xMatrix 没能准备好这次重启，什么都没有启动。",
      steps: ["确认 {source} 的 Agent 还接在这个 Space 上，再发一次 reborn。"] },
  },
} as const satisfies Record<string, ProblemRow>;

export type LifecycleKind = "handoff" | "reborn";
const LIFECYCLE: Record<LifecycleKind, Readonly<Record<string, ProblemRow>>> = { handoff: HANDOFF_REFUSALS, reborn: REBORN_REFUSALS };

/** The row a refusal code reads from: an exact row, or its family's. */
export function lifecycleRefusalRow(kind: LifecycleKind, code: string): ProblemRow {
  const rows = LIFECYCLE[kind];
  if (Object.hasOwn(rows, code)) return rows[code]!;
  if (kind === "handoff") {
    if (["registration_not_found", "registration_harness_unavailable", "registration_machine_unavailable"].includes(code)) return HANDOFF_REFUSALS.no_machine;
    // Every other registration_* failure is the successor launch, which runs after the source stopped.
    if (code.startsWith("registration_") && code !== "registration_handoff_failed") return HANDOFF_REFUSALS.launch_failed;
    return HANDOFF_REFUSALS.registration_handoff_failed;
  }
  return REBORN_REFUSALS.registration_reborn_failed;
}

/** The handoff a reader writes instead: @auto, unless @auto is what failed. */
export function otherHandoff(source: string, successor: string | undefined): string {
  return /^@auto$/iu.test((successor ?? "").trim()) ? `${source}:handoff:@<agent>` : `${source}:handoff:@auto`;
}

export function lifecycleRefusalWords(kind: LifecycleKind, code: string, locale: ProblemLocale,
  values: { source: string; successor?: string }): ProblemWords {
  const successor = values.successor ?? (locale === "zh" ? "新的 Agent" : "the new Agent");
  return fill(lifecycleRefusalRow(kind, code)[locale], { source: values.source, successor,
    other: otherHandoff(values.source, values.successor) });
}

/** The Channel text: the English row, its code at the end for CLI and Agent readers. */
export function lifecycleRefusalText(kind: LifecycleKind, code: string, values: { source: string; successor?: string }): string {
  const words = lifecycleRefusalWords(kind, code, "en", values);
  return [words.title + ".", words.explanation, ...words.steps].filter(Boolean).join(" ") + ` [${code}]`;
}

/** A refusal note's code: recorded beside it, or the one its older fixed sentence carried. */
export function lifecycleRefusalCode(note: { code?: string; body: string } | undefined): string | undefined {
  if (note?.code) return note.code;
  const body = note?.body ?? "";
  return body.match(/^xMatrix could not hand off \S+ to .+ \(([a-z][a-z0-9_]{0,79})\)\./u)?.[1]
    ?? body.match(/^Reborn failed \[([a-z][a-z0-9_]{0,79})\] for /u)?.[1]
    ?? (/^xMatrix could not find \S+ to (?:hand off|reborn)\.$/u.test(body) ? "lifecycle_source_not_found" : undefined)
    ?? (/^xMatrix refused an invalid (?:handoff source|reborn target) for /u.test(body) ? "lifecycle_source_invalid" : undefined);
}

/* ---------------------------------------------------------------------------
 * Launch rejections: why a summon never allocated a launch. The English is
 * PREPARATION_REJECTION_MESSAGES (the Hub's wire text); this is every row's
 * Chinese cause, without "no launch was allocated", which the card says.
 * ------------------------------------------------------------------------- */

const JEV_FAILURES_ZH: Record<string, string> = {
  invalid_answer: "返回了无效的结果", jev_aborted: "超时了", jev_invalid_input: "拒绝了这次判断请求",
  jev_customer_verification_required: "需要先完成服务商账号验证", jev_auth_failed: "服务商认证失败",
  jev_permission_denied: "被服务商拒绝了", jev_rate_limited: "被服务商限流了", jev_evaluation_failed: "在服务商那边失败了",
};
const MENTION_ONLY_ZH = "这条消息只是提到了这个 Agent，没有让它开始干活。Agent 要用 xmatrix send --launch 才会启动一个。";

export const LAUNCH_REJECTION_CAUSES_ZH: Readonly<Record<string, string>> = {
  registration_parameter_unavailable: "没有哪个可用的运行程序支持你指定的参数和取值。",
  routing_selection_failed: "xMatrix 没能选出运行环境。",
  routing_parameter_selection_failed: "选择启动参数失败了。",
  routing_parameter_constraints_invalid: "你指定的参数和选中的运行环境对不上。",
  routing_parameter_models_empty: "按选中的环境和你指定的参数，没有剩下可用的模型或推理强度。",
  routing_parameter_workspaces_empty: "按选中的环境和你指定的参数，没有剩下获准使用的仓库或目录。",
  routing_parameter_catalog_invalid: "启动参数清单无效，或者超出了上限。",
  routing_parameter_catalog_unavailable: "读不到选中环境的启动参数清单。",
  routing_parameter_invalid_answer: "xMatrix 在选择启动参数时返回了无效结果。",
  routing_parameter_jev_aborted: "xMatrix 选择启动参数超时了。",
  routing_parameter_jev_invalid_input: "xMatrix 拒绝了这次启动参数请求。",
  routing_parameter_jev_customer_verification_required: "路由模型的服务商需要先完成账号验证。",
  routing_parameter_jev_auth_failed: "路由模型的服务商认证失败。",
  routing_parameter_jev_permission_denied: "路由模型的服务商拒绝了这次请求。",
  routing_parameter_jev_rate_limited: "路由模型的服务商限流了这次请求。",
  routing_parameter_jev_evaluation_failed: "路由模型的服务商在选择启动参数时出错了。",
  routing_evidence_unavailable: "没能保存这次判断的记录。",
  registration_evidence_unavailable: "没能保存这次判断的记录。",
  registration_context_unavailable: "读不到这个对话的内容，还没开始选择。",
  registration_environment_selection_failed: "xMatrix 没能选出一台已接入的电脑。",
  registration_parameter_selection_failed: "已经选好电脑，但选择启动参数失败了。",
  registration_selection_failed: "选择电脑或启动参数失败了。",
  registration_selection_unconfigured: "这里还没有为已接入的电脑配置路由。",
  registration_selection_invalid: "xMatrix 的选择已经和你获准使用的资源对不上了。",
  registration_not_found: "没有哪台已接入的电脑能用获准的模型和工作目录运行这次调用。",
  registration_candidates_limit: "匹配这次调用的电脑太多了。",
  registration_machine_unavailable: "你指定的电脑上没有这个 Agent。可以在 Agents 页面或用 xmatrix agent list 查看每台电脑能跑哪些 Agent。",
  registration_machine_ambiguous: "不止一个人有同名的电脑；请通过电脑主人的 Agent 来指定。",
  registration_harness_unavailable: "没有哪台电脑能在其余条件下运行你指定的程序。可以在 Agents 页面或用 xmatrix agent list 查看每台电脑能跑哪些 Agent。",
  registration_model_unavailable: "没有哪台电脑能在其余条件下提供你指定的模型。",
  registration_effort_unavailable: "没有哪台电脑能在其余条件下提供你指定的推理强度。",
  registration_directory_unavailable: "你指定的目录没有对任何符合其余条件的电脑开放。",
  registration_quota_exhausted: "能运行它的 Agent 都用完了服务商额度。换一个 Agent，或者等额度重置后再发一次消息。",
  registration_machine_not_auto_assigned: "只有主人设为「不自动分配」的电脑能运行它；用 machine:<名字> 指定一台（xmatrix agent list 会标出这些电脑）。",
  ...Object.fromEntries((["environment", "parameter"] as const).flatMap(phase =>
    Object.entries(JEV_FAILURES_ZH).map(([reason, description]) => [`registration_${phase}_${reason}`,
      `xMatrix 在${phase === "environment" ? "选择电脑" : "选择启动参数"}时${description}。`]))),
  ...Object.fromEntries(MENTION_ONLY_REJECTION_CODES.map(code => [code, MENTION_ONLY_ZH])),
  registration_runtime_unknown: "这个 Agent 没有声明启动命令，它的程序也没有 Hub 预设的运行方式。",
  registration_launch_rejected: "按当前的配置或权限，这次调用没法启动。",
  registration_workspace_or_daemon_unavailable: "选中电脑上的 xMatrix 后台或工作目录现在不可用。",
  registration_daemon_offline: "运行这个 Agent 的电脑离线了。打开那台电脑并启动 xMatrix，再发一次消息。",
  registration_harness_outdated: "那台电脑上的 Agent 程序版本太旧，xMatrix 用不了。在那台电脑上更新后再试。",
  registration_workspace_not_configured: "选中的 Agent 没有为这次启动配置工作目录。",
  registration_workspace_constraint_mismatch: "选中的工作目录不符合这次调用要求的仓库或目录。",
  registration_workspaces_limit: "匹配这次调用的工作目录太多了。",
  registration_invocation_target_mismatch: "选中的 Agent 和你 @ 的不是同一个。",
  registration_source_changed: "启动准备好之前，原消息被改过了。",
  registration_environment_changed: "启动准备好之前，选中的电脑变了。",
  registration_launch_changed: "这次调用之前的启动用的是另一套配置。",
  registration_launch_aborted: "启动在准备好之前被中止了。",
  registration_launch_recovery_unavailable: "这次调用之前的启动没法恢复。",
  invalid_registration_launch: "这次启动请求无效。",
  invalid_registration_repository: "仓库地址无效。",
  registration_repo_route_unavailable: "选中的电脑上没有唯一一个在线、能克隆并启动这个仓库的 xMatrix 后台。",
  registration_managed_route_unavailable: "选中的电脑上没有唯一一个在线、能运行托管目录的 xMatrix 后台。",
  registration_environment_ineligible: "选中的电脑已停用、不在可用时段，或者没有开放所选的模型或能力。",
  registration_environment_missing: "选中的 Agent 没有声明在哪台电脑上运行。",
  registration_not_granted: "这个 Agent 的主人没有允许这个 Space 或对话使用它。",
  space_policy_exceeds_owner_grant: "Space 的策略要求的比 Agent 主人允许的更多。",
  registration_resource_not_admitted: "你要的工作目录、模型、密钥或能力没有对这个 Agent 开放。",
  routing_no_eligible: "没有符合这次调用的运行环境。",
  routing_selection_unconfigured: "这个部署没有配置运行环境的选择。",
  routing_quota_refresh_failed: "刷新运行环境的可用情况失败了。",
  routing_candidates_failed: "读不到运行环境列表。",
  routing_syntax_invalid: "这次调用的参数没法解析。",
  agent_execution_config_invalid: "这个 Agent 的运行配置需要先修好才能启动。",
  machine_route_incomplete: "这个 Agent 的电脑配置不完整。",
  machine_route_ambiguous: "这个 Agent 该用哪台电脑不明确。",
  workspace_required: "请为这次调用选择一个绝对路径的工作目录或一个仓库。",
  workspace_syntax_invalid: "请使用绝对路径的工作目录或仓库地址；路径里有空格要加引号。",
  workspace_ambiguous: "这个目录匹配了不止一个工作目录。",
  workspace_unavailable: "选中的 Agent 用不了这个工作目录。",
  workspace_not_found: "这个目录没有为选中的 Agent 登记。请选一个可用的工作目录。",
  idempotency_mismatch: "这次调用和它最初的请求对不上了，没有再启动第二个 Agent。",
};

/** A launch rejection's cause in the reader's language. English keeps the
 * Hub's detail-specific wording (which machines, which versions); Chinese
 * words the code, and an unknown code falls back to the English. */
export function launchRejectionCause(code: string, locale: ProblemLocale, detail?: unknown): string | undefined {
  if (locale === "zh" && Object.hasOwn(LAUNCH_REJECTION_CAUSES_ZH, code)) return LAUNCH_REJECTION_CAUSES_ZH[code];
  return preparationFailureSummary(code, detail);
}
