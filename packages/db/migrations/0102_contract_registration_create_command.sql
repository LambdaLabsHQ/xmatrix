-- A human adds an Agent on their own machine in one command (declare, offer,
-- grant and enable), audited beside offer and configure. Widening the check is
-- safe for every serving Hub: older Hubs only record offer and configure.
--
-- Apply before any Hub that records `create` commands serves traffic.
--
-- Idempotent: a second run replaces the check with the same one.

SET LOCAL lock_timeout = '5s';

ALTER TABLE data.agent_registration_commands
  DROP CONSTRAINT IF EXISTS agent_registration_commands_command_kind_check,
  ADD CONSTRAINT agent_registration_commands_command_kind_check
    CHECK (command_kind IN ('offer', 'configure', 'create'));
