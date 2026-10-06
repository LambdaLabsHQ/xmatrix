-- Every Space is the same kind of Space; Hubs no longer write data.spaces.kind.
-- 0146_contract_drop_space_kind drops the column once no serving Hub reads it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.spaces ALTER COLUMN kind DROP NOT NULL;
