-- A Machine is named once per owner. The name is data, not identity: renaming
-- updates this row only, and no other record stores it. machine_id keeps its
-- place in every key (docs/architecture/machine-identity.md).
CREATE TABLE data.machines (
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL CHECK (length(machine_id) BETWEEN 1 AND 300),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64 AND name = btrim(name)
    AND name !~ '[[:cntrl:]]'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  renamed_at TIMESTAMPTZ,
  PRIMARY KEY (owner_user_id, machine_id)
);

CREATE UNIQUE INDEX machines_owner_name_key ON data.machines (owner_user_id, lower(name));

-- Every Machine already known gets the host name its latest daemon reported.
-- A name another of the owner's Machines already holds gets -2, -3, ...; the
-- earliest-enrolled Machine keeps the bare name.
DO $backfill$
DECLARE
  machine RECORD;
  base TEXT;
  candidate TEXT;
  suffix INTEGER;
BEGIN
  FOR machine IN
    SELECT known.owner_user_id, known.machine_id, min(known.created_at) AS first_seen,
      (SELECT COALESCE(NULLIF(btrim(daemon.host_name), ''), NULLIF(btrim(daemon.host_id), ''))
        FROM data.machine_daemons daemon
        WHERE daemon.owner_user_id = known.owner_user_id AND daemon.machine_id = known.machine_id
        ORDER BY daemon.updated_at DESC, daemon.daemon_id LIMIT 1) AS host
    FROM (
      SELECT owner_user_id, machine_id, created_at FROM data.machine_daemons
      UNION ALL
      SELECT owner_user_id, machine_id, created_at FROM data.agent_registrations
    ) known
    GROUP BY known.owner_user_id, known.machine_id
    ORDER BY min(known.created_at), known.owner_user_id, known.machine_id
  LOOP
    base := left(btrim(regexp_replace(COALESCE(machine.host, 'machine'), '[[:cntrl:]]', '', 'g')), 56);
    IF base = '' THEN base := 'machine'; END IF;
    candidate := base;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM data.machines existing
      WHERE existing.owner_user_id = machine.owner_user_id AND lower(existing.name) = lower(candidate)) LOOP
      suffix := suffix + 1;
      candidate := base || '-' || suffix;
    END LOOP;
    INSERT INTO data.machines (owner_user_id, machine_id, name, created_at)
    VALUES (machine.owner_user_id, machine.machine_id, candidate, machine.first_seen);
  END LOOP;
END
$backfill$;
