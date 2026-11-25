import pg from "pg";
for (const db of ["xmatrix_prod","xmatrix_prod_shard_1"]) {
  const u = new URL(process.env.POSTGRES_RUNTIME_DATABASE_URL); u.searchParams.delete("sslmode"); u.pathname="/"+db;
  const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } }); await c.connect();
  await c.query("BEGIN READ ONLY");
  const r = await c.query(`SELECT author_id, space_id, count(*) FILTER (WHERE deleted_at IS NULL AND created_at < now()-interval '29 days') AS overdue,
    count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted, count(*) AS total
    FROM data.messages WHERE author_kind='app' AND author_id IN ('gmail','google','googlecalendar','gcp') GROUP BY 1,2 ORDER BY 1`);
  const e = await c.query(`SELECT provider_id, count(*) AS overdue FROM data.app_connector_executions WHERE provider_id IN ('gmail','google','googlecalendar','gcp')
    AND created_at < now()-interval '29 days' AND (result_summary IS NOT NULL OR reason IS NOT NULL) GROUP BY 1`);
  console.log(db, JSON.stringify(r.rows.map(x=>({...x, space_id:x.space_id.slice(0,8)}))), JSON.stringify(e.rows));
  await c.query("ROLLBACK"); await c.end();
}
