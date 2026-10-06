-- One causal head belongs to owner + Machine + Channel, independent of hostname.
-- Keep the highest (connection epoch, registry sequence) before changing the key.
-- A temporary legacy unique constraint admits the previous Hub's unchanged-host
-- upserts during deployment; inconsistent old observations fail closed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$
DECLARE
  pending BIGINT;
  key_columns TEXT[];
  changed INTEGER;
  iteration INTEGER;
BEGIN
  LOCK TABLE data.machine_run_snapshot_heads IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO pending FROM (SELECT 1 FROM data.machine_run_snapshot_heads LIMIT 100001) bounded;
  IF pending > 100000 THEN RAISE EXCEPTION 'Snapshot scope consolidation exceeds 100000 rows'; END IF;
  SELECT array_agg(attribute.attname::TEXT ORDER BY columns.ordinality) INTO key_columns
    FROM pg_constraint constraint_record
    CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY columns(attnum,ordinality)
    JOIN pg_attribute attribute ON attribute.attrelid=constraint_record.conrelid AND attribute.attnum=columns.attnum
    WHERE constraint_record.conrelid='data.machine_run_snapshot_heads'::regclass AND constraint_record.contype='p';
  IF key_columns = ARRAY['owner_user_id','machine_id','channel_id'] THEN RETURN; END IF;
  IF key_columns IS DISTINCT FROM ARRAY['owner_user_id','machine_id','host_id','channel_id'] THEN
    RAISE EXCEPTION 'Unexpected Machine snapshot primary key; refuse consolidation';
  END IF;
  FOR iteration IN 1..100 LOOP
    WITH ranked AS (SELECT ctid,row_number() OVER (PARTITION BY owner_user_id,machine_id,channel_id
      ORDER BY connection_epoch DESC,registry_sequence DESC,captured_at DESC,updated_at DESC,host_id DESC) AS position
      FROM data.machine_run_snapshot_heads), batch AS (SELECT ctid FROM ranked WHERE position>1 LIMIT 1000)
    DELETE FROM data.machine_run_snapshot_heads head USING batch WHERE head.ctid=batch.ctid;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed < 1000;
  END LOOP;
  IF EXISTS (SELECT 1 FROM data.machine_run_snapshot_heads GROUP BY owner_user_id,machine_id,channel_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Snapshot scope consolidation has remaining rows; retry';
  END IF;
  ALTER TABLE data.machine_run_snapshot_heads DROP CONSTRAINT machine_run_snapshot_heads_pkey;
  ALTER TABLE data.machine_run_snapshot_heads ADD PRIMARY KEY (owner_user_id,machine_id,channel_id);
  ALTER TABLE data.machine_run_snapshot_heads ALTER COLUMN host_id DROP NOT NULL;
  ALTER TABLE data.machine_run_snapshot_heads ADD CONSTRAINT machine_run_snapshot_heads_legacy_observation_key
    UNIQUE (owner_user_id,machine_id,host_id,channel_id);
END
$$;
