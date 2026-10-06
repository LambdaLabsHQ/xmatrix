-- A bounded, retryable observation backfill before legacy columns are removed.
-- It does not change Machine identities, chosen names, epochs or grants.
-- Old observation fields remain readable while supported clients still send them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  target REGCLASS;
  pending BIGINT;
  changed INTEGER;
  iteration INTEGER;
BEGIN
  -- Refuse an unexpectedly large operation before any row is rewritten.
  SELECT count(*) INTO pending FROM data.machine_daemons
    WHERE hostname IS NULL AND COALESCE(NULLIF(host_name,''),NULLIF(host_id,'')) IS NOT NULL;
  IF pending > 100000 THEN RAISE EXCEPTION 'Machine hostname backfill exceeds 100000 rows'; END IF;
  SELECT count(*) INTO pending FROM data.secret_grant_audit
    WHERE space_id IS NULL AND action='space_read' AND machine_id IS NULL AND host_id IS NOT NULL;
  IF pending > 100000 THEN RAISE EXCEPTION 'Space audit backfill exceeds 100000 rows'; END IF;
  FOR target IN SELECT unnest(ARRAY['data.workspaces'::REGCLASS,'data.runs'::REGCLASS]) LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE NOT metadata_json ? ''hostname''
      AND (jsonb_typeof(metadata_json->''hostName'')=''string'' OR jsonb_typeof(metadata_json->''hostId'')=''string'')', target)
      INTO pending;
    IF pending > 100000 THEN RAISE EXCEPTION '% hostname backfill exceeds 100000 rows', target; END IF;
  END LOOP;

  FOR iteration IN 1..100 LOOP
    WITH batch AS (SELECT daemon_id FROM data.machine_daemons
      WHERE hostname IS NULL AND COALESCE(NULLIF(host_name,''),NULLIF(host_id,'')) IS NOT NULL
      ORDER BY daemon_id LIMIT 1000 FOR UPDATE)
    UPDATE data.machine_daemons d SET hostname=COALESCE(NULLIF(d.host_name,''),NULLIF(d.host_id,''))
      FROM batch WHERE d.daemon_id=batch.daemon_id;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed < 1000;
  END LOOP;

  FOR target IN SELECT unnest(ARRAY['data.workspaces'::REGCLASS,'data.runs'::REGCLASS]) LOOP
    FOR iteration IN 1..100 LOOP
      EXECUTE format('WITH batch AS (SELECT ctid FROM %s WHERE NOT metadata_json ? ''hostname''
        AND (jsonb_typeof(metadata_json->''hostName'')=''string'' OR jsonb_typeof(metadata_json->''hostId'')=''string'')
        ORDER BY ctid LIMIT 1000 FOR UPDATE)
        UPDATE %s d SET metadata_json=d.metadata_json || jsonb_build_object(''hostname'',
          CASE WHEN jsonb_typeof(d.metadata_json->''hostName'')=''string'' AND d.metadata_json->>''hostName''<>''''
            THEN d.metadata_json->''hostName'' ELSE d.metadata_json->''hostId'' END)
        FROM batch WHERE d.ctid=batch.ctid', target, target);
      GET DIAGNOSTICS changed = ROW_COUNT;
      EXIT WHEN changed < 1000;
    END LOOP;
  END LOOP;

  -- host_id on these events is a Space id, not a hostname. Preserve its domain.
  FOR iteration IN 1..100 LOOP
    WITH batch AS (SELECT command_id FROM data.secret_grant_audit
      WHERE space_id IS NULL AND action='space_read' AND machine_id IS NULL AND host_id IS NOT NULL
      ORDER BY command_id LIMIT 1000 FOR UPDATE)
    UPDATE data.secret_grant_audit audit SET space_id=audit.host_id
      FROM batch WHERE audit.command_id=batch.command_id;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed < 1000;
  END LOOP;

  IF EXISTS (SELECT 1 FROM data.machine_daemons WHERE hostname IS NULL
      AND COALESCE(NULLIF(host_name,''),NULLIF(host_id,'')) IS NOT NULL) OR
     EXISTS (SELECT 1 FROM data.secret_grant_audit WHERE space_id IS NULL
      AND action='space_read' AND machine_id IS NULL AND host_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Hostname or Space audit backfill has remaining rows; retry the bounded operation';
  END IF;
  FOR target IN SELECT unnest(ARRAY['data.workspaces'::REGCLASS,'data.runs'::REGCLASS]) LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE NOT metadata_json ? ''hostname''
      AND (jsonb_typeof(metadata_json->''hostName'')=''string'' OR jsonb_typeof(metadata_json->''hostId'')=''string'')', target)
      INTO pending;
    IF pending > 0 THEN RAISE EXCEPTION '% hostname backfill has remaining rows; retry', target; END IF;
  END LOOP;
END
$$;
