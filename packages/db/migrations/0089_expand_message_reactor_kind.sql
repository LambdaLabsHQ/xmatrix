-- A reaction is a participant's own response, and Agents participate too. The
-- relation row now names what kind of principal reacted: 'user' or 'agent'.
-- reactor_user_id keeps holding the reactor's id (the Human's user id, or the
-- Agent id its messages carry). NULL is a row written before this column
-- existed, and every such row is a Human's. A nullable column and an
-- unvalidated check keep this metadata-only: no rewrite, no validation scan.
ALTER TABLE data.message_reactions ADD COLUMN reactor_kind TEXT;
ALTER TABLE data.message_reactions ADD CONSTRAINT message_reactions_reactor_kind_check
  CHECK (reactor_kind IS NULL OR reactor_kind IN ('user', 'agent')) NOT VALID;
