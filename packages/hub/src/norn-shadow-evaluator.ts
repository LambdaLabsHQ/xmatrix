import type { NornShadowEvaluator, ShadowEvidence, ShadowTransition } from "@xmatrix/db";
import { compileAstJson } from "./vendor/norn/runtime/code";
import { advance, machineVersion, resume, start, type Effect, type Machine } from "./vendor/norn/runtime/machine";
import { show, text, unit, variant, type Value } from "./vendor/norn/runtime/value";
import { sha256 } from "./vendor/norn/runtime/sha256";

type Request = { id: string; holder: string; epoch: number; mapped: boolean; outcome: Value | null; outcomeAt: number | null };
type Target = { kind: "request"; id: string } | { kind: "timer"; at: number; discard: boolean };
type State = { format: "norn-shadow:1"; machine: Machine; requests: Request[]; coverage: "pending" | "observed" | "incomplete";
  wait: { targets: Target[]; until: number | null; withdraw: string[] } | null };
class InvalidEffect extends Error {}
const invalid = (): never => { throw new InvalidEffect(); };
function millis(value: Value,now: number): number {
  if (value.type !== "time" && value.type !== "duration") return invalid();
  const at = BigInt(value.value)+(value.type === "duration" ? BigInt(now) : 0n);
  if (at < 0n || at > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
  return Number(at);
}
function targets(value: Value,now: number): Target[] | null {
  const selected: Target[] = [],pending = [{ value,discard: false }];
  while (pending.length) {
    const { value: current,discard } = pending.pop()!;
    if (current.type === "request") { selected.push({ kind: "request",id: current.id }); continue; }
    if (current.type !== "source") return null;
    if (current.name === "never") continue;
    if (current.name === "merge" || current.name === "or") {
      for (let i=current.args.length-1;i>=0;i--) pending.push({ value: current.args[i],discard: discard || current.name === "or" });
      continue;
    }
    if (current.name !== "after" && current.name !== "every") return null;
    if (current.args.length !== 1 || Object.keys(current.labels).length) return invalid();
    const duration = current.args[0];
    if (duration.type !== "time" && (duration.type !== "duration" || BigInt(duration.value) <= 0n)) return invalid();
    if (current.name === "every" && duration.type !== "duration") return invalid();
    selected.push({ kind: "timer",at: millis(duration,now),discard });
  }
  return selected;
}
function receipt(evidence: ShadowEvidence): Value {
  return variant("Done",{ type: "record",fields: {
    receipt: text(evidence.finalReplyId!),run: text(evidence.runId),execution: text(evidence.executionId),
    declaration: text(evidence.declaration),
  } });
}

/** No runtime driver, DurableStore, SimulatedHost or transport is reachable here.
 * @dormant The operator supplies exact-source observations; no automatic cohort. */
export const nornShadowEvaluator: NornShadowEvaluator = {
  abi: machineVersion,
  create(ast,now) {
    const code = compileAstJson(ast);
    const state: State = { format: "norn-shadow:1",machine: start(code,now),requests: [],coverage: "pending",wait: null };
    return { codeId: code.id,snapshot: state };
  },
  advance(ast,snapshot,selection,evidence,now) {
    const code = compileAstJson(ast),state = structuredClone(snapshot) as State;
    let intent: ShadowTransition["intent"] = null;
    const result = (kind: string,reason: string,status: ShadowTransition["state"],
      classification: ShadowTransition["classification"] = "incomplete",disposition?: ShadowTransition["disposition"]): ShadowTransition => {
      const due = state.wait ? [...state.wait.targets.filter(t => t.kind === "timer").map(t => (t as Extract<Target,{kind: "timer"}>).at),
        ...(state.wait.until === null ? [] : [state.wait.until])] : [];
      const control = state.machine.control;
      const final = control.kind === "done" ? control.value : control.kind === "failed" ? control.outcome : null;
      const outcomeTag = final?.type === "variant" && ["Done","Failed","TimedOut","Cancelled","Revoked","Declined","Some","None","Ok","Err"].includes(final.name)
        ? final.name : final?.type ?? null;
      return { snapshot: state,state: status,kind,reason,classification,due: due.length ? Math.min(...due) : null,
        outcomeTag,intent,
        ...(disposition ? { disposition } : {}) };
    };
    if (state.format !== "norn-shadow:1" || state.machine.version !== machineVersion || state.machine.codeId !== code.id) {
      return result("unsupported","unsupported_checkpoint","incomplete");
    }
    const request = (value: Value): Request => {
      if (value.type !== "request") return invalid();
      return state.requests.find(item => item.id === value.id) ?? invalid();
    };
    try {
      if (evidence?.finalReplyId && !["accepted","running","completed"].includes(evidence.declaration)) {
        return result("unsupported","unmapped_source_outcome","incomplete");
      }
      // A final message can precede the authenticated terminal report. Wait
      // for that report; failure/interruption needs its own typed mapping.
      if (evidence?.declaration !== "completed") evidence = null;
      if (state.wait) {
        const waiting = state.wait;
        const due: { at: number; priority: number; kind: "deadline" | "timer" | "request"; target?: Target; fresh?: boolean }[] = [];
        if (waiting.until !== null && now >= waiting.until) due.push({ at: waiting.until,priority: 0,kind: "deadline" });
        for (const target of waiting.targets) {
          if (target.kind === "timer" && now >= target.at) due.push({ at: target.at,priority: 1,kind: "timer",target });
          if (target.kind === "request") {
            const current = state.requests.find(item => item.id === target.id) ?? invalid();
            if (current.outcome && current.outcomeAt! <= now) due.push({ at: current.outcomeAt!,priority: 1,kind: "request",target });
            else if (current.mapped && current.epoch === 1 && evidence?.finalReplyId && evidence.observedAt <= now) {
              due.push({ at: evidence.observedAt,priority: 1,kind: "request",target,fresh: true });
            }
          }
        }
        // The earliest authoritative observation wins. At equal times the
        // deadline wins. Servicing a checkpoint late does not rewrite history.
        const winner = due.sort((a,b) => a.at-b.at || a.priority-b.priority)[0];
        if (winner?.kind === "deadline") {
          for (const id of waiting.withdraw) {
            const current = state.requests.find(item => item.id === id);
            if (current && !current.outcome) { current.outcome = variant("Cancelled"); current.outcomeAt = winner.at; }
          }
          // An independent wait may lose while the original request receives
          // its answer. It is not withdrawn by the observation's deadline.
          for (const candidate of due.filter(item => item.kind === "request" && item.fresh)) {
            if (candidate.target?.kind !== "request" || waiting.withdraw.includes(candidate.target.id)) continue;
            const id = candidate.target.id;
            const current = state.requests.find(item => item.id === id)!;
            current.outcome = receipt(evidence!); current.outcomeAt = candidate.at;
          }
          state.wait = null; resume(state.machine,variant("TimedOut"),now);
          return result("timeout","exclusive_deadline","ready","intentional_difference",evidence?.finalReplyId ? "late" : undefined);
        }
        if (winner?.target?.kind === "timer") {
          const target = winner.target;
          state.wait = null; resume(state.machine,variant("Done",target.discard ? unit : { type: "time",value: String(target.at) }),now);
          return result("wake","timer_due","ready");
        }
        if (winner?.target?.kind === "request") {
          const id = winner.target.id;
          const current = state.requests.find(item => item.id === id)!;
          if (winner.fresh) {
            current.outcome = receipt(evidence!); current.outcomeAt = winner.at;
            if (state.coverage !== "incomplete") state.coverage = "observed";
          }
          state.wait = null; resume(state.machine,current.outcome!,now);
          return result("wake",winner.fresh ? "exact_final_receipt" : "recorded_candidate_outcome","ready",
            state.coverage === "observed" ? "equivalent" : "incomplete",winner.fresh ? "consumed" : undefined);
        }
        if (waiting.targets.some(target => target.kind === "request" && state.requests.some(item => item.id === target.id && item.epoch > 1)) && evidence?.finalReplyId) {
          return result("late","previous_holder","waiting","incomplete","obsolete");
        }
        return result("idle","evidence_unavailable","waiting");
      }
      const pending = state.requests.find(item => item.mapped && item.epoch === 1 && !item.outcome);
      if (pending && evidence?.finalReplyId) {
        pending.outcome = receipt(evidence); pending.outcomeAt = evidence.observedAt;
        if (state.coverage !== "incomplete") state.coverage = "observed";
        return result("observe","exact_final_receipt","ready","equivalent","consumed");
      }
      state.machine.resumedAt = now;
      advance(code,state.machine,1000);
      const control = state.machine.control;
      if (control.kind === "done") return result("outcome","candidate_completed","completed",state.coverage === "observed" ? "equivalent" : "incomplete");
      if (control.kind === "failed") {
        const expected = control.outcome.type === "variant" && ["TimedOut","Cancelled","Revoked"].includes(control.outcome.name);
        return result("outcome","candidate_failed","failed",expected ? "intentional_difference" : "unexpected");
      }
      if (control.kind === "report") {
        intent = { operation: "execution.handler_failed",digest: sha256(JSON.stringify(control.outcome)) };
        resume(state.machine,unit,now);
        return result("notification","handler_failure_proposed","ready");
      }
      if (control.kind !== "effect") return result("yield","computation_slice","ready");
      intent = { operation: control.effect.name,digest: sha256("norn-shadow-effect:1\0"+JSON.stringify(control.effect)) };
      return effect(control.effect);

      function effect(value: Effect): ShadowTransition {
        const { name,args,labels } = value;
        const allowed: Record<string,string[]> = { run: ["until"],start: [],wait: ["until"],
          cancel: [],handOver: [],status: [],say: [] };
        // Missing host support remains unknown. It never calls a model or an app.
        if (!Object.hasOwn(allowed,name)) return result("unsupported","unsupported_effect","incomplete");
        if (Object.keys(labels).some(label => !allowed[name].includes(label))) return result("unsupported","unsupported_constraint","incomplete");
        const until = labels.until ? millis(labels.until,now) : null;
        const finish = (returned: Value,kind: string,reason: string) => {
          resume(state.machine,returned,now); return result(kind,reason,"ready");
        };
        if (name === "run" || name === "start") {
          if (args.length !== 2 || args[0].type !== "participant" || args[1].type !== "string") return invalid();
          const holder = show(args[0]);
          // One explicitly selected causal source. A repeated/similar request
          // cannot reuse its final receipt, even if its words/recipient match.
          const mapped = state.requests.length === 0 && holder === selection.participant && args[1].value === selection.sourceRef &&
            !Object.keys(args[0].labels).length;
          const id = `request:${state.requests.length}`;
          if (!mapped) state.coverage = "incomplete";
          state.requests.push({ id,holder,epoch: 1,mapped,outcome: null,outcomeAt: null });
          if (name === "start") return finish({ type: "request",id },"intent",mapped ? "mapped_request_proposed" : "unmapped_request_proposed");
          state.wait = { targets: [{ kind: "request",id }],until,withdraw: [id] };
          return result("wait",mapped ? "mapped_request_wait" : "unmapped_request_wait","waiting");
        }
        if (name === "wait") {
          if (args.length !== 1) return invalid();
          const selected = targets(args[0],now);
          if (selected === null) return result("unsupported","unmapped_fact_or_stream","incomplete");
          state.wait = { targets: selected,until,withdraw: [] };
          return result("wait","candidate_wait_registered","waiting");
        }
        if (name === "say") {
          if (args.length !== 2 || !["participant","ref"].includes(args[0].type) || args[1].type !== "string") return invalid();
          state.coverage = "incomplete";
          return finish(unit,"intent","message_proposed");
        }
        if (args.length !== (name === "handOver" ? 2 : 1)) return invalid();
        const current = request(args[0]);
        if (name === "status") return finish(current.outcome ? variant("Some",current.outcome) : variant("None"),"status","candidate_status_read");
        if (name === "cancel") {
          if (!current.outcome) { current.outcome = variant("Cancelled"); current.outcomeAt = now; }
          state.coverage = "incomplete";
          return finish(unit,"intent","cancel_proposed");
        }
        if (args[1].type !== "participant") return invalid();
        if (!current.outcome) { current.epoch++; current.holder = show(args[1]); current.mapped = false; }
        state.coverage = "incomplete";
        return finish({ type: "request",id: current.id },"intent","handover_proposed");
      }
    } catch (error) {
      if (!(error instanceof InvalidEffect)) throw error;
      return result("outcome","invalid_effect_arguments","failed","unexpected");
    }
  },
};
