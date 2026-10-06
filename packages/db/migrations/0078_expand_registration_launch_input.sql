-- A registration launch no longer requires a source message. Launches invoked
-- from a Human message keep the message fence; any other input carries none.
ALTER TABLE data.registration_launch_intents ALTER COLUMN source_message_id DROP NOT NULL;
ALTER TABLE data.registration_launch_intents ALTER COLUMN source_revision DROP NOT NULL;
