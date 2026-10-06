-- `data.extension_records` keys every row by (namespace, record_id) alone, across
-- every Space on the shard. The identity is deliberate: the extension store looks a
-- record up by namespace and id without a scope. It is also a trap for any writer
-- that carries an id over from the per-Space Durable Object storage, where the Space
-- was implicit -- the Focus namespace did exactly that and collided the moment a
-- second Space wrote. Record the invariant where the schema is read.
COMMENT ON COLUMN data.extension_records.record_id IS
  'Unique within its namespace across every scope: the primary key excludes scope_kind and scope_id, so a namespace that stores one record per Space (or per Human) must embed that scope in the id.';

COMMENT ON COLUMN data.extension_records.scope_id IS
  'Authorization and listing scope of the record. It fences reads, but it is not part of the record identity.';
