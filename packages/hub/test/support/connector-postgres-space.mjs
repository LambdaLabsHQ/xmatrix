import { connectorDatabase } from "../../../db/test/postgres-database.fixture.mjs";

/**
 * A Space with one owner and one configured connection of a provider, for a
 * PostgreSQL connector test. Its rows are removed afterwards, whatever the test did.
 */
export async function withConnectorSpace({ name, providerId, providerName, authMode }, run) {
  const { client, database, sql } = await connectorDatabase(`${name}-test`);
  const space = `${name}-${crypto.randomUUID()}`;
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'owner','owner',1,now(),now())`, [space]);
    await sql(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
       capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES ($1,$1||':'||$2,1,$2,$3,'configured',$4,'[]','[]','[]','[]','owner',$1||':rank',
        now()-interval '1 second',now()-interval '1 second')`, [space, providerId, providerName, authMode]);
    return await run({ space, database, sql });
  } finally {
    for (const table of ["app_connector_credentials", "app_connector_connections", "space_members"]) {
      await sql(`DELETE FROM data.${table} WHERE space_id=$1`, [space]);
    }
    await database.close?.();
    await client.end();
  }
}
