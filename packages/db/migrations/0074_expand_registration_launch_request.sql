-- Preserve the exact selected launch request across interrupted preparation.
-- NULL marks historical intents; recovery must not invent their missing fields.
ALTER TABLE data.registration_launch_intents
  ADD COLUMN launch_request_json JSONB
  CHECK (launch_request_json IS NULL OR
    (jsonb_typeof(launch_request_json)='object' AND octet_length(launch_request_json::text)<=131072));
