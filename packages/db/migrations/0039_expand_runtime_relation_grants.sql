DO $migration$
DECLARE
  runtime_role TEXT := current_database() || '_runtime';
  relation RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RETURN;
  END IF;

  FOR relation IN
    SELECT namespace.nspname AS schema_name, class.relname AS relation_name
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname IN ('control', 'data')
      AND class.relkind IN ('r', 'p')
      AND class.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    ORDER BY namespace.nspname, class.relname
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
      relation.schema_name,
      relation.relation_name,
      runtime_role
    );
  END LOOP;

  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA control '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    current_user,
    runtime_role
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA data '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    current_user,
    runtime_role
  );
END
$migration$;
