CREATE INDEX machine_request_delivery_status_idx
  ON data.machine_daemon_commands
    (owner_user_id, machine_id, host_id, (payload_json->>'daemonRequestId'), created_at DESC, command_id DESC)
  WHERE command_type = 'request_resolve';
