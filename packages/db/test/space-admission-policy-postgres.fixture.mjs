import { createHash } from "node:crypto";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const ALLOW_ALL = "pub let admit = (req: Admission.request) => Allow";

/** The fixture Space with a Page, a Page program on it, and that program's open request delivered in the Run's Channel. */
export async function programFixture() {
  const f = await spaceSecretFixture();
  const page = `${f.ids.space}:page`, program = `${f.ids.space}:program`, delivery = `norn:${f.ids.space}:0`;
  const source = "run(@claude, \"Check the database\")->wait";
  await f.client.query(`INSERT INTO data.pages (space_id,page_id,position,access_mode,head_revision,version,created_by_user_id,created_at,updated_at)
    VALUES ($1,$2,'a0','open',1,1,$3,now(),now())`, [f.ids.space, page, f.ids.admin]);
  await f.client.query(`INSERT INTO data.norn_programs
    (space_id,channel_id,program_id,author_kind,author_id,authority_user_id,source,ledger_json,state,page_id,page_name)
    VALUES ($1,$2,$3,'user',$4,$4,$5,'{}','running',$6,'patrol')`, [f.ids.space, f.ids.channel, program, f.ids.admin, source, page]);
  await f.client.query(`INSERT INTO data.norn_requests (space_id,channel_id,program_id,request_id,request_ref,epoch,holder,delivery_message_id)
    VALUES ($1,$2,$3,'request-1',$4,0,'@claude',$5)`, [f.ids.space, f.ids.channel, program, `r${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, delivery]);
  const execution = async (sourceMessageId, state) => {
    const id = crypto.randomUUID();
    await f.client.query(`INSERT INTO data.agent_message_executions
      (binding_id,space_id,channel_id,run_id,instance_id,execution_id,revision,binding_digest,report_digest,source_message_id,
       source_entity_version,source_body_hash,source_sequence,source_count,state,started_at_millis,updated_at_millis,created_at,observed_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$1,1,repeat('a',64),repeat('b',64),$6,1,repeat('c',64),1,1,$7,1,1,now(),now(),now()+interval '30 days')`,
    [id, f.ids.space, f.ids.channel, f.ids.run, f.ids.instance, sourceMessageId, state]);
    return id;
  };
  const launchedBy = (triggerId) => f.client.query(`INSERT INTO data.agent_launches
    (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,instance_id,execution_key,control_id,machine_id,state,
     spawn_payload_json,next_attempt_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'registration',$5,$6,$7,$8,$1,$9,'connected','{}',now(),now(),now())`,
  [crypto.randomUUID(), f.ids.space, f.ids.channel, triggerId, f.ids.owner, f.ids.run, f.ids.instance, f.context.executionKey, f.ids.machine]);
  const adopt = (sourceText = ALLOW_ALL) => f.secret.adoptAdmissionPolicy({ spaceId: f.ids.space, userId: f.ids.admin, pageId: page,
    libraryName: "Access", sourceText, sourceSha256: sha256(sourceText) });
  return { ...f, page, program, delivery, source, execution, launchedBy, adopt,
    work: { program: `${page}/patrol`, digest: sha256(source) },
    async close() {
      for (const table of ["agent_message_executions", "agent_launches", "norn_requests", "norn_programs", "space_admission_policies"]) {
        await f.client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [f.ids.space]);
      }
      await f.client.query("DELETE FROM data.secret_grant_audit WHERE space_id=$1", [f.ids.space]);
      await f.close();
    } };
}
