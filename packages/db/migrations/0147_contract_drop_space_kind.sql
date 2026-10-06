-- Every Space is the same kind of Space. Apply once every serving Hub neither
-- reads nor writes data.spaces.kind (the release after
-- 0145_expand_space_kind_optional).

SET LOCAL lock_timeout = '5s';

ALTER TABLE data.spaces DROP COLUMN kind;
