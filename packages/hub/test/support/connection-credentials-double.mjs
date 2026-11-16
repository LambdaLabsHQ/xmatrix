/**
 * The connection-credentials module as connector-commands uses it: `read` answers the action's
 * credentials at version 1, and each renewal an action saves is recorded with the version it named.
 */
export function connectionCredentialsDouble(read, renewals = []) {
  return {
    connectionCredentials: read,
    connectionCredentialGrant: async (...args) => ({ values: await read(...args), version: 1 }),
    credentialRenewal: (_env, _spaceId, _providerId, version) => async (fields) => { renewals.push({ version, fields }); },
  };
}
