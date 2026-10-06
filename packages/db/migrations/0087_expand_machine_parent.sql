-- A WSL distribution is its own Machine; its Windows host is recorded so the
-- two are shown together. Presentation only: it grants nothing.
ALTER TABLE data.machines ADD COLUMN parent_machine_id TEXT CHECK (length(parent_machine_id) BETWEEN 1 AND 300);
