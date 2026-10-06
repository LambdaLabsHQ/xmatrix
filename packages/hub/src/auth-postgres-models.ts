export const AUTH_POSTGRES_MODELS = Object.freeze({
  user: Object.freeze({
    modelName: "control.auth_users",
    fields: Object.freeze({
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    }),
    additionalFields: Object.freeze({
      profileVersion: "profile_version",
      profileCompletedAt: "profile_completed_at",
    }),
  }),
  session: Object.freeze({
    modelName: "control.auth_sessions",
    fields: Object.freeze({
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      userId: "user_id",
    }),
  }),
  account: Object.freeze({
    modelName: "control.auth_accounts",
    fields: Object.freeze({
      accountId: "account_id",
      providerId: "provider_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    }),
  }),
  verification: Object.freeze({
    modelName: "control.auth_verifications",
    fields: Object.freeze({
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    }),
  }),
  jwks: Object.freeze({
    modelName: "control.auth_jwks",
    fields: Object.freeze({
      publicKey: "public_key",
      privateKey: "private_key",
      createdAt: "created_at",
      expiresAt: "expires_at",
    }),
  }),
});
