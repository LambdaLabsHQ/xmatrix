import { formatZonedDateTime } from "./time-display";
import { parsePresentedRoutingDecision, routingChoiceIdentity, type LaunchParameterEvidence, routingDecisionCopy, routingExclusionText,
  routingQuotaText, routingHarnessLabel, visibleRoutingChoiceRows, type LaunchDecisionStage, type PresentedRoutingDecision,
  type RoutingChoiceRow } from "@xmatrix/protocol";

export { parsePresentedRoutingDecision };

/** One Jev answer: what it chose, its distribution and the exact input it read. */
function DecisionStage({ label, stage }: { label: string; stage: LaunchDecisionStage }) {
  return <div>
    <p>{label}: {stage.selected}
      {Object.entries(stage.probabilities).map(([option, probability]) =>
        <span key={option}> · {option}: {(probability * 100).toFixed(1)}%</span>)}</p>
    <code>{label} input digest: {stage.inputDigest}</code>
  </div>;
}

const FIT_LEVELS = ["unsuitable", "capable", "strong fit", "asked for"];

/** Jev's fit for each harness and the environments weighed on fit and headroom together. */
function JointPlacement({ parameters }: { parameters: LaunchParameterEvidence }) {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return <div>
    {parameters.fit && <>
      <p>Harness fit{Object.entries(parameters.fit.scores).map(([harness, fit]) =>
        <span key={harness}> · {routingHarnessLabel(harness)}: {FIT_LEVELS[Math.round(fit.score)]} ({fit.score.toFixed(2)})</span>)}</p>
      <code>Fit input digest: {parameters.fit.inputDigest}</code>
    </>}
    {parameters.placement && <ol aria-label="Environments weighed on fit and headroom">
      {parameters.placement.ranking.map((item, index) => <li key={`${index}:${item.harness}:${item.machineId}`}>
        {routingHarnessLabel(item.harness)} on {item.machineName || "Unnamed machine"} · fit {percent(item.fit)} ·
        headroom {item.headroom === undefined ? "unmeasured" : percent(item.headroom)}
        {item.frontier ? "" : " · outweighed on both"}</li>)}
    </ol>}
  </div>;
}

/** The chosen environment as the selection step states it; the step's own
 *  label already says who chose. */
export function routingSelectionNote(decision: PresentedRoutingDecision | undefined): string | undefined {
  const selected = decision?.rows.find(row => row.selected);
  const repo = decision?.parameters?.selections.repo;
  return selected ? [routingChoiceIdentity(selected), routingQuotaText(selected), ...(repo ? [`repo ${repo}`] : [])].join(" · ") : undefined;
}

/** A Machine is shown by its name; its id is never a label. */
function machineCaption(row: RoutingChoiceRow): string {
  return row.machineLabel || "Unnamed machine";
}

function RoutingRow({ row, rank }: { row: RoutingChoiceRow; rank?: number }) {
  const harness = routingHarnessLabel(row.harness);
  const name = row.label || harness;
  const detail = [
    row.label ? harness : undefined,
    machineCaption(row),
    row.ownerLabel && row.ownerLabel !== row.label ? row.ownerLabel : undefined,
    `${row.activeRuns} active instances · machine total: ${row.machineActiveRuns ?? "unknown"}`,
  ].filter(Boolean).join(" · ");
  return <li className="app-routing-row" data-selected={row.selected || undefined}
    data-excluded={row.excluded?.length ? "true" : undefined} title={routingChoiceIdentity(row)}>
    <span className="app-routing-rank">{rank ?? ""}</span>
    <span className="app-routing-name">{name}{row.selected ? <span className="app-routing-started">Selected</span> : null}</span>
    <span className="app-routing-meta">{detail}</span>
    <span className="app-routing-quota">
      {row.excluded?.length ? <span className="app-routing-reason">{routingExclusionText(row.excluded)}</span> : null}
      <span className="app-routing-meter" data-quota={row.remainingQuota === undefined || row.quotaAssumed ? "default" : "known"} aria-hidden="true">
        {<span style={{ width: `${row.quotaAssumed ? 0 : row.remainingQuota ?? 0}%` }} />}
      </span>
      <span>{routingQuotaText(row)}</span>
    </span>
    <details className="app-routing-meta"><summary>Observed facts</summary>
      <p>CPU: {row.machineResources?.cpuLogicalCount ?? "unknown"} logical cores · usage: {row.machineResources?.cpuUsagePercent ?? "unknown"}%</p>
      <p>Memory: {row.machineResources?.memoryAvailableBytes ?? "unknown"} bytes available / {row.machineResources?.memoryTotalBytes ?? "unknown"} bytes total</p>
      {row.lastSpawnFailureAt && <p>Last spawn failure {formatZonedDateTime(row.lastSpawnFailureAt)}</p>}
      {row.machineResources && <p>Resources observed {formatZonedDateTime(row.machineResources.observedAt)}</p>}
      {row.quotaObservation && <p>Quota: {row.quotaObservation.status}
        {row.quotaObservation.source && <> · {row.quotaObservation.source}</>}
        {row.quotaObservation.observedAt && <> · observed {formatZonedDateTime(row.quotaObservation.observedAt)}</>}
        {row.quotaObservation.expiresAt && <> · expires {formatZonedDateTime(row.quotaObservation.expiresAt)}</>}
      </p>}
    </details>
  </li>;
}

function RoutingSection({ title, rows, ranked }: { title: string; rows: RoutingChoiceRow[]; ranked?: boolean }) {
  return <div className="app-routing-section">
    <p className="app-routing-section-title">{title} ({rows.length})</p>
    <ol className="app-routing-list" aria-label={title}>
      {rows.map((row, index) => <RoutingRow key={`${index}:${row.harness}:${row.machineId}:${row.label ?? ""}:${row.excluded?.join(",") ?? "in"}`}
        row={row} rank={ranked ? index + 1 : undefined} />)}
    </ol>
  </div>;
}

/** `evidenceOnly` is for a launch, whose progress row already names the
 *  choice: the board then restates no verdict of its own. */
export function RoutingDecisionBoard({ decision, compact = false, evidenceOnly = false }: {
  decision: PresentedRoutingDecision; compact?: boolean; evidenceOnly?: boolean;
}) {
  const copy = routingDecisionCopy(decision);
  const rows = visibleRoutingChoiceRows(decision.rows);
  const eligible = rows.filter(row => !row.excluded?.length);
  const excluded = rows.filter(row => row.excluded?.length);
  if (compact) {
    const selected = rows.find(row => row.selected);
    return <section className="app-routing-board" aria-label="Routing decision">
      <p className="app-routing-verdict">{selected ? `Selected environment: ${routingChoiceIdentity(selected)}` : copy.verdict}</p>
      <details className="app-invocation-request"><summary>Candidate observations</summary>
        {eligible.length ? <RoutingSection title="Eligible" rows={eligible} /> : null}
        {excluded.length ? <RoutingSection title="Not eligible" rows={excluded} /> : null}
      </details>
    </section>;
  }
  return <section className="app-routing-board" aria-label="Routing decision">
    {!evidenceOnly && <>
      <p className="app-routing-verdict">{copy.verdict}</p>
      <p className="app-routing-rule">{copy.rule}</p>
      <p>{rows.length} candidates in the requested scope.</p>
    </>}
    {decision.parameters && <details className="app-invocation-request"><summary>Launch parameter decisions</summary>
      {decision.parameters.selections.model && <p>Model: {decision.parameters.selections.model} · Effort: {decision.parameters.selections.effort ?? "harness default"}</p>}
      <p>Workspace: {decision.parameters.selections.workspaceKind}{decision.parameters.selections.repo ? ` · ${decision.parameters.selections.repo}` : ""}</p>
      <p>Evaluated {formatZonedDateTime(decision.parameters.evaluatedAt)} · {decision.parameters.rubricVersion}</p>
      {decision.parameters.harness && <DecisionStage label="Harness" stage={decision.parameters.harness} />}
      {(decision.parameters.fit || decision.parameters.placement) && <JointPlacement parameters={decision.parameters} />}
      {decision.parameters.environment && <DecisionStage label="Environment" stage={decision.parameters.environment} />}
      {decision.parameters.choices.map(choice => <p key={choice.key}>{choice.key}: {choice.selected}
        {Object.entries(choice.probabilities).map(([option, probability]) => <span key={option}> · {option}: {(probability * 100).toFixed(1)}%</span>)}
      </p>)}
      <code>Input digest: {decision.parameters.inputDigest}</code>
    </details>}
    <div className="app-routing-rows" aria-label={`${rows.length} environments checked`}>
      {eligible.length ? <RoutingSection title="Eligible" rows={eligible} /> : null}
      {excluded.length ? <RoutingSection title="Not eligible" rows={excluded} /> : null}
    </div>
  </section>;
}
