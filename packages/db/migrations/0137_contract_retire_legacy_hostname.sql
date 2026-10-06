-- Apply only after hostname-only PostgreSQL writers are deployed.
-- Retire legacy observation columns without changing identities or executions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$
DECLARE
  target REGCLASS;
  pending BIGINT;
  changed INTEGER;
  iteration INTEGER;
  key_columns TEXT[];
BEGIN
  LOCK TABLE data.workspaces, data.runs, data.machine_daemons,
    data.agent_launches, data.agent_reborn_intents, data.machine_daemon_commands,
    data.machine_run_routes, data.machine_run_snapshot_heads,
    data.machine_run_terminal_reports, data.registration_stop_intents,
    data.secret_grant_audit IN ACCESS EXCLUSIVE MODE;
  FOR target IN SELECT unnest(ARRAY[
    'data.machine_daemons'::REGCLASS, 'data.agent_launches'::REGCLASS,
    'data.agent_reborn_intents'::REGCLASS, 'data.machine_daemon_commands'::REGCLASS,
    'data.machine_run_routes'::REGCLASS, 'data.machine_run_snapshot_heads'::REGCLASS,
    'data.machine_run_terminal_reports'::REGCLASS, 'data.registration_stop_intents'::REGCLASS]) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=target AND attname='hostname'
        AND NOT attisdropped) THEN
      RAISE EXCEPTION '% has no replacement hostname column; refuse legacy contraction', target;
    END IF;
  END LOOP;
  SELECT array_agg(attribute.attname::TEXT ORDER BY columns.ordinality) INTO key_columns
    FROM pg_constraint constraint_record
    CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY columns(attnum,ordinality)
    JOIN pg_attribute attribute ON attribute.attrelid=constraint_record.conrelid AND attribute.attnum=columns.attnum
    WHERE constraint_record.conrelid='data.machine_run_snapshot_heads'::regclass AND constraint_record.contype='p';
  IF key_columns IS DISTINCT FROM ARRAY['owner_user_id','machine_id','channel_id'] THEN
    RAISE EXCEPTION 'Snapshot identity cutover has not completed; refuse legacy contraction';
  END IF;
  FOR target IN SELECT unnest(ARRAY['data.workspaces'::REGCLASS,'data.runs'::REGCLASS,'data.machine_daemons'::REGCLASS]) LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM %s
      WHERE metadata_json ?| ARRAY[''hostId'',''hostName''] LIMIT 100001) bounded', target) INTO pending;
    IF pending > 100000 THEN RAISE EXCEPTION '% legacy metadata retirement exceeds 100000 rows', target; END IF;
  END LOOP;
  -- Historical space_read host_id carried a Space id. Preserve that domain.
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='data.secret_grant_audit'::regclass
      AND attname='host_id' AND NOT attisdropped) THEN
    SELECT count(*) INTO pending FROM (SELECT 1 FROM data.secret_grant_audit
      WHERE space_id IS NULL AND action='space_read' AND machine_id IS NULL AND host_id IS NOT NULL LIMIT 100001) bounded;
    IF pending > 100000 THEN RAISE EXCEPTION 'Space audit preservation exceeds 100000 rows'; END IF;
  END IF;
  FOR target IN SELECT unnest(ARRAY['data.workspaces'::REGCLASS,'data.runs'::REGCLASS,'data.machine_daemons'::REGCLASS]) LOOP
    FOR iteration IN 1..100 LOOP
      EXECUTE format('WITH batch AS (SELECT ctid FROM %s WHERE metadata_json ?| ARRAY[''hostId'',''hostName'']
        ORDER BY ctid LIMIT 1000 FOR UPDATE)
        UPDATE %s d SET metadata_json=(CASE WHEN d.metadata_json ? ''hostname'' THEN d.metadata_json
          WHEN jsonb_typeof(d.metadata_json->''hostName'')=''string'' AND d.metadata_json->>''hostName''<>''''
            THEN d.metadata_json || jsonb_build_object(''hostname'',d.metadata_json->''hostName'')
          WHEN jsonb_typeof(d.metadata_json->''hostId'')=''string''
            THEN d.metadata_json || jsonb_build_object(''hostname'',d.metadata_json->''hostId'')
          ELSE d.metadata_json END)-''hostId''-''hostName'' FROM batch WHERE d.ctid=batch.ctid', target,target);
      GET DIAGNOSTICS changed = ROW_COUNT;
      EXIT WHEN changed < 1000;
    END LOOP;
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM %s
      WHERE metadata_json ?| ARRAY[''hostId'',''hostName''] LIMIT 1) remaining',target) INTO pending;
    IF pending > 0 THEN RAISE EXCEPTION '% legacy metadata remains; retry',target; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='data.secret_grant_audit'::regclass
      AND attname='host_id' AND NOT attisdropped) THEN
    FOR iteration IN 1..100 LOOP
      WITH batch AS (SELECT command_id FROM data.secret_grant_audit
        WHERE space_id IS NULL AND action='space_read' AND machine_id IS NULL AND host_id IS NOT NULL
        ORDER BY command_id LIMIT 1000 FOR UPDATE)
      UPDATE data.secret_grant_audit audit SET space_id=audit.host_id
        FROM batch WHERE audit.command_id=batch.command_id;
      GET DIAGNOSTICS changed = ROW_COUNT;
      EXIT WHEN changed < 1000;
    END LOOP;
    IF EXISTS (SELECT 1 FROM data.secret_grant_audit WHERE space_id IS NULL
        AND action='space_read' AND machine_id IS NULL AND host_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Space audit preservation has remaining rows; retry';
    END IF;
  END IF;
END
$$;
ALTER TABLE data.agent_launches DROP COLUMN IF EXISTS host_id;
ALTER TABLE data.agent_reborn_intents DROP COLUMN IF EXISTS host_id;
ALTER TABLE data.machine_daemon_commands DROP COLUMN IF EXISTS host_id;
ALTER TABLE data.machine_daemons DROP COLUMN IF EXISTS host_id, DROP COLUMN IF EXISTS host_name;
ALTER TABLE data.machine_run_routes DROP COLUMN IF EXISTS host_id;
ALTER TABLE data.machine_run_snapshot_heads DROP COLUMN IF EXISTS host_id;
ALTER TABLE data.machine_run_terminal_reports DROP COLUMN IF EXISTS host_id, DROP COLUMN IF EXISTS host_name;
ALTER TABLE data.registration_stop_intents DROP COLUMN IF EXISTS host_id;
ALTER TABLE data.secret_grant_audit DROP COLUMN IF EXISTS host_id;
