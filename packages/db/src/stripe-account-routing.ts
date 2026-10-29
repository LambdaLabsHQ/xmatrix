/** Native grants and manual credentials are mutually exclusive, including an old in-flight writer. */
export const STRIPE_NATIVE_GRANT_SQL = `a.connection_id=c.connection_id AND a.space_id=c.space_id
  AND c.provider_id='stripe' AND a.status='active' AND NOT a.legacy_pending AND a.encrypted_value_json IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials manual WHERE manual.connection_id=c.connection_id
    AND manual.field_names_json-'ingressKey'<>'[]'::jsonb)`;
