-- Apply only after the serving Hub no longer reads or writes Channel rules.
-- Connection permission_mode is now the sole durable app permission.
SET LOCAL lock_timeout = '5s';
DROP TABLE data.app_connector_action_policies;
