-- An owner keeps a Machine out of automatic assignment: while auto_assign is
-- FALSE, a launch places work there only when its author names the Machine
-- (`machine:`, a directory registered on it, or one of its registrations).
-- NULL is the default: the Machine takes part.

-- Fail fast instead of queueing Machine writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.machines ADD COLUMN auto_assign BOOLEAN;
