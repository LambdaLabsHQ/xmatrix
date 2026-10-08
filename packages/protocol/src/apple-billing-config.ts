export interface AppleSubscriptionConfig {
  keyId: string;
  issuerId: string;
  privateKey: string;
  appAppleId: number;
  monthlyProductId: string;
  annualProductId: string;
  sandboxSpaceIds: string[];
}

export function parseAppleSubscriptionConfig(raw: string | undefined): AppleSubscriptionConfig {
  try {
    if (!raw || raw.length > 32_768) throw new Error();
    const value = JSON.parse(raw);
    const fields = ["keyId", "issuerId", "privateKey", "appAppleId", "monthlyProductId", "annualProductId", "sandboxSpaceIds"];
    if (!value || typeof value !== "object" || Object.keys(value).some((key) => !fields.includes(key)) ||
        typeof value.keyId !== "string" || !/^[A-Z0-9]{10}$/.test(value.keyId) || typeof value.issuerId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.issuerId) ||
        typeof value.privateKey !== "string" || !value.privateKey.startsWith("-----BEGIN PRIVATE KEY-----") ||
        !Number.isSafeInteger(value.appAppleId) || value.appAppleId <= 0 ||
        !Array.isArray(value.sandboxSpaceIds) || value.sandboxSpaceIds.length > 20 ||
        value.sandboxSpaceIds.some((id: unknown) => typeof id !== "string" || !id || id.length > 300)) throw new Error();
    for (const field of ["monthlyProductId", "annualProductId"]) {
      if (typeof value[field] !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(value[field])) throw new Error();
    }
    if (value.monthlyProductId === value.annualProductId) throw new Error();
    return value as AppleSubscriptionConfig;
  } catch { throw new Error("Invalid Apple subscription configuration"); }
}
