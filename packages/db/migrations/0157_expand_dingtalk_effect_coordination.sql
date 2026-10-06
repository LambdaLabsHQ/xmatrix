-- Deliberately independent of product/grant/job foreign keys and participant
-- uniqueness. A decision must remain writable while both participants prepare.
CREATE TABLE control.dingtalk_effect_journal (
  binding_digest TEXT PRIMARY KEY CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  effect_id TEXT NOT NULL CHECK (length(effect_id) BETWEEN 1 AND 200),
  binding_json JSONB NOT NULL CHECK (jsonb_typeof(binding_json)='object'),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing','commit_decided','abort_decided','committed','aborted')),
  leader_epoch BIGINT NOT NULL DEFAULT 1 CHECK (leader_epoch>=1),
  leader_until TIMESTAMPTZ NOT NULL,
  decision_deadline TIMESTAMPTZ NOT NULL,
  source_prepared BOOLEAN NOT NULL DEFAULT false,
  target_prepared BOOLEAN NOT NULL DEFAULT false,
  source_proved BOOLEAN NOT NULL DEFAULT false,
  target_proved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (state NOT IN ('commit_decided','committed') OR (source_prepared AND target_prepared)),
  CHECK (state NOT IN ('committed','aborted') OR (source_proved AND target_proved))
);
CREATE INDEX dingtalk_effect_identity_idx ON control.dingtalk_effect_journal(effect_id,created_at,binding_digest);
CREATE INDEX dingtalk_effect_recovery_idx ON control.dingtalk_effect_journal(state,updated_at,binding_digest);
CREATE INDEX dingtalk_effect_company_idx ON control.dingtalk_effect_journal(company_digest,state);
-- These rows are local to each physical participant. No FK to the journal:
-- target has no primary journal and a prepared gate cannot block journal CAS.
CREATE TABLE control.dingtalk_effect_gates (
  gid TEXT PRIMARY KEY CHECK (gid ~ '^xmatrix:dtfx:[a-f0-9]{64}:[1-9][0-9]{0,11}:[st]$'),
  binding_digest TEXT NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  plan_json JSONB NOT NULL CHECK (jsonb_typeof(plan_json)='object'),
  closed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (split_part(gid,':',3)=binding_digest)
);
-- Receipt/pin is written in the product prepared transaction, never in the
-- journal. It contains digest/outcome evidence only, with no product FK.
CREATE TABLE control.dingtalk_effect_outcomes (
  gid TEXT PRIMARY KEY CHECK (gid ~ '^xmatrix:dtfx:[a-f0-9]{64}:[1-9][0-9]{0,11}:[st]$'),
  binding_digest TEXT NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome='committed'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (split_part(gid,':',3)=binding_digest)
);
