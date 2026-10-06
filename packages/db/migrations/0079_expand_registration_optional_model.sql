-- An invocation with no reported/selected model uses the runtime's defaults.
-- Preserve legacy rows; new default allocations leave runtime_model absent.
ALTER TABLE control.registration_execution_allocations ALTER COLUMN runtime_model DROP NOT NULL;
