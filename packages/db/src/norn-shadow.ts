import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { requireChannelCapability } from "./channel-capability-policy.js";
import { openNornComparison, sealNornComparison } from "./secret-value-control.js";
import { nornShadowSource } from "./norn-shadow-source.js";
import { comparisonId, comparisonJson, NORN_SHADOW_HOST, NORN_SHADOW_MAPPING, NornShadowError,
  shadowFields as field, type NornShadowEvaluator, type ShadowSelection } from "./norn-shadow-values.js";
import type { QueryResultRow } from "pg";
import { commandDigest } from "./command-digest.js";

type Request = { requestId: string; actorUserId: string; channelId: string; comparisonId: string };
const denied = () => new NornShadowError("norn_comparison_unavailable",404,"Comparison is unavailable");
const terminal = new Set(["completed","failed","incomplete","revoked"]);
function view(row: QueryResultRow) {
  return { comparisonId: String(row.comparison_id),revision: Number(row.revision),state: String(row.state),
    reason: String(row.reason),codeId: String(row.code_id),hostVersion: String(row.host_version),
    mappingVersion: String(row.mapping_version),nextDueAt: row.next_due_at ? new Date(row.next_due_at).toISOString() : null,
    expiresAt: new Date(row.expires_at).toISOString() };
}

/** @dormant Opt-in operator API. No route, source hook, scheduler or dispatcher constructs it. */
export class PostgresNornShadowRepository {
  constructor(private readonly database: AuthorityDatabase,private readonly placement: DatabasePlacementContext,
    private readonly material: string,private readonly evaluator: NornShadowEvaluator) {
    if (database.cacheMode !== "disabled" || !material) throw new NornShadowError("norn_authority_unavailable",503,"Uncached authority and encryption are required");
  }
  private transaction<T>(input: Request, operation: string, body: (tx: DatabaseTransaction) => Promise<T>) {
    comparisonId(input.comparisonId);
    field.text(input.actorUserId,"actorUserId"); field.text(input.channelId,"channelId");
    return this.database.transaction({ requestId: field.text(input.requestId,"requestId",200),
      operation: `norn-shadow.${operation}`,placement: this.placement },body);
  }
  private async authorize(tx: DatabaseTransaction,input: Request) {
    const grant = await tx.query({ name: "norn_shadow_owner_v1",text: `SELECT role,extract(epoch from created_at)::text||'/'||version AS generation
      FROM data.space_members WHERE space_id=$1 AND user_id=$2 FOR SHARE`,
      values: [this.placement.spaceId,input.actorUserId],maxRows: 1 });
    if (!grant[0] || !["owner","admin"].includes(String(grant[0].role))) return null;
    try {
      await requireChannelCapability(tx,{ spaceId: this.placement.spaceId,channelId: input.channelId,
        principal: { kind: "user",id: input.actorUserId },capability: "runtime_continue",error: denied });
    } catch (error) { if (error instanceof NornShadowError) return null; throw error; }
    return String(grant[0].generation);
  }
  private async lock(tx: DatabaseTransaction,input: Request) {
    const [row] = await tx.query({ name: "norn_shadow_lock_v1",text: `SELECT * FROM data.norn_shadow_comparisons
      WHERE space_id=$1 AND channel_id=$2 AND comparison_id=$3::uuid AND owner_user_id=$4 FOR UPDATE`,
      values: [this.placement.spaceId,input.channelId,input.comparisonId,input.actorUserId],maxRows: 1 });
    if (!row) throw denied();
    return row;
  }
  private async now(tx: DatabaseTransaction): Promise<number> {
    const [row] = await tx.query({ name: "norn_shadow_authority_time_v1",
      text: "SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS millis",maxRows: 1 });
    return Number(row.millis);
  }
  async admit(input: Request & { ast: string; sourceBindingId: string; participant: string }) {
    const ast = input.ast, bindingId = field.text(input.sourceBindingId,"sourceBindingId"),participant = field.text(input.participant,"participant");
    comparisonJson({ ast });
    return this.transaction(input,"admit",async tx => {
      const generation = await this.authorize(tx,input);
      if (!generation) throw denied();
      // Same-Space admission serialization bounds capacity without a global lock.
      await tx.query({ name: "norn_shadow_admission_lock_v1",text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        values: [`norn-shadow:${this.placement.spaceId}`],maxRows: 1 });
      const now = await this.now(tx), initial = this.evaluator.create(ast,now);
      const admissionDigest = await commandDigest([initial.codeId,bindingId,participant,input.channelId,input.actorUserId]);
      const existing = await tx.query({ name: "norn_shadow_admission_replay_v1",text: `SELECT * FROM data.norn_shadow_comparisons
        WHERE space_id=$1 AND comparison_id=$2::uuid`,values: [this.placement.spaceId,input.comparisonId],maxRows: 1 });
      if (existing.length) {
        const prior = existing[0];
        if (prior.admission_digest === admissionDigest && prior.owner_generation === generation &&
            Number(prior.placement_epoch) === this.placement.placementEpoch) return view(prior);
        throw new NornShadowError("norn_admission_exists",409,"A replacement requires a new comparison id");
      }
      const source = await nornShadowSource(tx,{ spaceId: this.placement.spaceId,channelId: input.channelId },bindingId);
      if (!source) throw denied();
      if (!source.source.agentName || !source.source.channelInstanceId ||
          participant !== `@${source.source.agentName}:${source.source.channelInstanceId}`) {
        throw new NornShadowError("norn_source_participant_mismatch",409,"The selected binding does not name this participant");
      }
      const capacity = await tx.query({ name: "norn_shadow_capacity_v1",text: `SELECT 1 FROM data.norn_shadow_comparisons
        WHERE space_id=$1 LIMIT 32`,values: [this.placement.spaceId],maxRows: 32 });
      if (capacity.length >= 32) throw new NornShadowError("norn_comparison_capacity",503,"Expire old comparisons before admitting another");
      const selection: ShadowSelection = { bindingId,participant,sourceRef: `execution:${bindingId}` };
      const encrypted = await sealNornComparison(this.material,this.placement.spaceId,input.comparisonId,0,
        comparisonJson({ ast,snapshot: initial.snapshot,selection }));
      const [created] = await tx.query({ name: "norn_shadow_admit_v1",text: `INSERT INTO data.norn_shadow_comparisons
        (space_id,comparison_id,channel_id,owner_user_id,owner_generation,placement_epoch,source_binding_id,source_generation,
         source_message_id,source_run_id,source_instance_id,code_id,machine_abi,host_version,mapping_version,state,reason,encrypted_value_json,admission_digest)
        VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ready','admitted',$16::jsonb,$17) RETURNING *`,
        values: [this.placement.spaceId,input.comparisonId,input.channelId,input.actorUserId,generation,this.placement.placementEpoch,
          bindingId,source.generation,source.source.sourceMessageId,source.source.runId,source.source.instanceId,initial.codeId,
          this.evaluator.abi,NORN_SHADOW_HOST,NORN_SHADOW_MAPPING,JSON.stringify(encrypted),admissionDigest],maxRows: 1 });
      return view(created);
    });
  }
  private async end(tx: DatabaseTransaction,row: QueryResultRow,state: "revoked" | "incomplete",reason: string) {
    if (row.state === state && row.reason === reason && row.encrypted_value_json === null) return view(row);
    const [ended] = await tx.query({ name: "norn_shadow_end_v1",text: `UPDATE data.norn_shadow_comparisons
      SET state=$3,reason=$4,revision=revision+1,encrypted_value_json=NULL,next_due_at=NULL,updated_at=clock_timestamp()
      WHERE space_id=$1 AND comparison_id=$2::uuid RETURNING *`,values: [this.placement.spaceId,row.comparison_id,state,reason],maxRows: 1 });
    return view(ended);
  }
  async step(input: Request & { expectedRevision: number }) {
    field.integer(input.expectedRevision,"expectedRevision");
    return this.transaction(input,"step",async tx => {
      const generation = await this.authorize(tx,input),row = await this.lock(tx,input);
      if (!generation || generation !== row.owner_generation || Number(row.placement_epoch) !== this.placement.placementEpoch) {
        return this.end(tx,row,"revoked","authority_changed");
      }
      if (Number(row.revision) !== input.expectedRevision) throw new NornShadowError("norn_checkpoint_conflict",409,"Reload the comparison revision");
      if (row.state === "revoked") return view(row);
      const now = await this.now(tx);
      if (terminal.has(String(row.state))) {
        if (new Date(row.expires_at).getTime() <= now) return view(row);
        // Preserve terminal outcomes while retaining later losing evidence.
        const late = await nornShadowSource(tx,{ spaceId: this.placement.spaceId,channelId: input.channelId },String(row.source_binding_id));
        const retained = await tx.query({ name: "norn_shadow_terminal_capacity_v1",text: `SELECT 1 FROM data.norn_shadow_observations
          WHERE space_id=$1 AND comparison_id=$2::uuid LIMIT 256`,values: [this.placement.spaceId,input.comparisonId],maxRows: 256 });
        if (retained.length < 256 && late && late.generation === row.source_generation && late.evidence.finalReplyId) await tx.query({
          name: "norn_shadow_terminal_evidence_v1",text: `INSERT INTO data.norn_shadow_observations
            (space_id,comparison_id,channel_id,observation_id,disposition)
            VALUES ($1,$2::uuid,$3,$4,'late') ON CONFLICT DO NOTHING`,
          values: [this.placement.spaceId,input.comparisonId,input.channelId,late.evidence.id],maxRows: 0 });
        return view(row);
      }
      if (new Date(row.expires_at).getTime() <= now) return this.end(tx,row,"incomplete","observation_window_ended");
      if (row.machine_abi !== this.evaluator.abi || row.host_version !== NORN_SHADOW_HOST || row.mapping_version !== NORN_SHADOW_MAPPING) {
        return this.end(tx,row,"incomplete","unsupported_version");
      }
      const source = await nornShadowSource(tx,{ spaceId: this.placement.spaceId,channelId: input.channelId },String(row.source_binding_id));
      if (!source || source.generation !== row.source_generation) return this.end(tx,row,"incomplete","source_unavailable");
      const current = JSON.parse(await openNornComparison(this.material,row));
      // The immutable definition is still the one named at admission.
      if (this.evaluator.create(current.ast,now).codeId !== row.code_id) return this.end(tx,row,"incomplete","definition_mismatch");
      const counts = await tx.query({ name: "norn_shadow_transition_capacity_v1",text: `SELECT 1 FROM data.norn_shadow_transitions
        WHERE space_id=$1 AND comparison_id=$2::uuid LIMIT 256`,values: [this.placement.spaceId,input.comparisonId],maxRows: 256 });
      if (counts.length >= 256) return this.end(tx,row,"incomplete","comparison_storage_budget");
      const inputs = await tx.query({ name: "norn_shadow_input_capacity_v1",text: `SELECT observation_id FROM data.norn_shadow_observations
        WHERE space_id=$1 AND comparison_id=$2::uuid LIMIT 256`,values: [this.placement.spaceId,input.comparisonId],maxRows: 256 });
      if (inputs.length >= 256 && !inputs.some(item => item.observation_id === source.evidence.id)) return this.end(tx,row,"incomplete","comparison_storage_budget");
      await tx.query({ name: "norn_shadow_observe_v1",text: `INSERT INTO data.norn_shadow_observations
        (space_id,comparison_id,channel_id,observation_id,disposition) VALUES ($1,$2::uuid,$3,$4,'observed') ON CONFLICT DO NOTHING`,
        values: [this.placement.spaceId,input.comparisonId,input.channelId,source.evidence.id],maxRows: 0 });
      const [observation] = await tx.query({ name: "norn_shadow_observation_v1",text: `SELECT disposition,observed_at FROM data.norn_shadow_observations
        WHERE space_id=$1 AND comparison_id=$2::uuid AND observation_id=$3`,values: [this.placement.spaceId,input.comparisonId,source.evidence.id],maxRows: 1 });
      // Read after inbox insertion: the input's PG time cannot be later than
      // this evaluation cut merely because statements took a few milliseconds.
      const evaluationTime = await this.now(tx);
      if (new Date(row.expires_at).getTime() <= evaluationTime) return this.end(tx,row,"incomplete","observation_window_ended");
      const change = this.evaluator.advance(current.ast,current.snapshot,current.selection,
        observation.disposition === "observed" ? { ...source.evidence,observedAt: new Date(observation.observed_at).getTime() } : null,evaluationTime);
      // An idle recheck is not a new checkpoint or history entry.
      if (change.kind === "idle") return view(row);
      const revision = Number(row.revision)+1;
      const encrypted = terminal.has(change.state) ? null : await sealNornComparison(this.material,this.placement.spaceId,input.comparisonId,
        revision,comparisonJson({ ...current,snapshot: change.snapshot }));
      if (change.disposition) await tx.query({ name: "norn_shadow_observation_consume_v1",text: `UPDATE data.norn_shadow_observations
        SET disposition=$4 WHERE space_id=$1 AND comparison_id=$2::uuid AND observation_id=$3 AND disposition='observed'`,
        values: [this.placement.spaceId,input.comparisonId,source.evidence.id,change.disposition],maxRows: 0 });
      await tx.query({ name: "norn_shadow_transition_v1",text: `INSERT INTO data.norn_shadow_transitions
        (space_id,comparison_id,channel_id,revision,kind,classification,reason,observation_id,outcome_tag,operation,intent_digest,due_at)
        VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        values: [this.placement.spaceId,input.comparisonId,input.channelId,revision,change.kind,change.classification,change.reason,
          source.evidence.id,change.outcomeTag ?? null,change.intent?.operation ?? null,change.intent?.digest ?? null,
          change.due === null ? null : new Date(change.due).toISOString()],maxRows: 0 });
      const [committed] = await tx.query({ name: "norn_shadow_checkpoint_v1",text: `UPDATE data.norn_shadow_comparisons SET
        revision=$3,state=$4,reason=$5,encrypted_value_json=$6::jsonb,next_due_at=$7,updated_at=clock_timestamp()
        WHERE space_id=$1 AND comparison_id=$2::uuid AND revision=$8 RETURNING *`,
        values: [this.placement.spaceId,input.comparisonId,revision,change.state,change.reason,encrypted ? JSON.stringify(encrypted) : null,
          change.due === null ? null : new Date(change.due).toISOString(),input.expectedRevision],maxRows: 1 });
      if (!committed) throw new NornShadowError("norn_checkpoint_conflict",409,"Reload the comparison revision");
      return view(committed);
    });
  }
  async report(input: Request) {
    return this.transaction(input,"report",async tx => {
      if (!await this.authorize(tx,input)) throw denied();
      const row = await this.lock(tx,input);
      const transitions = await tx.query({ name: "norn_shadow_report_v1",text: `SELECT revision,kind,classification,reason,observation_id,outcome_tag,operation,intent_digest,due_at,recorded_at
        FROM data.norn_shadow_transitions WHERE space_id=$1 AND comparison_id=$2::uuid ORDER BY revision LIMIT 256`,
        values: [this.placement.spaceId,input.comparisonId],maxRows: 256 });
      return { ...view(row),transitions };
    });
  }
  async revoke(input: Request & { expectedRevision: number }) {
    return this.transaction(input,"revoke",async tx => {
      if (!await this.authorize(tx,input)) throw denied();
      const row = await this.lock(tx,input);
      if (Number(row.revision) !== input.expectedRevision) throw new NornShadowError("norn_checkpoint_conflict",409,"Reload the comparison revision");
      return terminal.has(String(row.state)) ? view(row) : this.end(tx,row,"revoked","operator_ended");
    });
  }
  /** Scoped bounded deletion; child journals cascade, never legacy records. */
  async maintain(requestId: string) {
    return this.database.transaction({ requestId,operation: "norn-shadow.expire",placement: this.placement },tx => tx.query({
      name: "norn_shadow_expire_v1",text: `WITH expired AS (SELECT comparison_id FROM data.norn_shadow_comparisons
        WHERE space_id=$1 AND expires_at<=clock_timestamp() ORDER BY expires_at,comparison_id LIMIT 32 FOR UPDATE SKIP LOCKED)
        DELETE FROM data.norn_shadow_comparisons c USING expired e WHERE c.space_id=$1 AND c.comparison_id=e.comparison_id RETURNING c.comparison_id`,
      values: [this.placement.spaceId],maxRows: 32 }));
  }
}
