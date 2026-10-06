import {
  isSpaceSecretAccess,
  SECRET_ENV_NAME_PATTERN,
  type SpaceSecretAccess,
  type SpaceSecretEntry,
} from "@xmatrix/protocol";

export type { SpaceSecretAccess, SpaceSecretEntry };

export type SecretCatalogFormMode = "create" | "edit";

export type SecretCatalogFormDraft = {
  secretRef: string;
  value: string;
  envName: string;
  description: string;
  access: SpaceSecretAccess;
};

export type SecretCatalogSavePayload = {
  secretRef: string;
  envName?: string;
  description: string | null;
  access: SpaceSecretAccess;
  value?: string;
};

export function secretCatalogFormDraft(entry?: SpaceSecretEntry): SecretCatalogFormDraft {
  return {
    secretRef: entry?.secretRef || "",
    value: "",
    envName: entry?.envName || "",
    description: entry?.description || "",
    access: entry?.access || "ask",
  };
}

export function normalizeSecretCatalogEntry(input: unknown): SpaceSecretEntry | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const secretRef = cleanString(record.secretRef);
  if (!secretRef) return null;
  const description = cleanString(record.description);
  return {
    secretRef,
    envName: cleanString(record.envName),
    ...(description ? { description } : {}),
    access: isSpaceSecretAccess(record.access) ? record.access : "ask",
    createdByUserId: cleanString(record.createdByUserId),
    createdAt: cleanString(record.createdAt),
    updatedAt: cleanString(record.updatedAt),
  };
}

/** A Space's secrets and whether the reader may change them; values never survive. */
export function normalizeSecretCatalogList(input: unknown): { secrets: SpaceSecretEntry[]; canManage: boolean } {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const candidates = Array.isArray(record.secrets) ? record.secrets : [];
  return {
    secrets: candidates
      .map((item) => normalizeSecretCatalogEntry(item))
      .filter((entry): entry is SpaceSecretEntry => Boolean(entry))
      .sort((left, right) => left.secretRef.localeCompare(right.secretRef)),
    canManage: record.canManage === true,
  };
}

export function validateSecretCatalogDraft(
  draft: SecretCatalogFormDraft,
  mode: SecretCatalogFormMode
): string | null {
  if (!draft.secretRef.trim()) return "Alias is required.";
  if (!isSpaceSecretAccess(draft.access)) return "Access must be auto or ask.";
  if (draft.envName.trim() && !SECRET_ENV_NAME_PATTERN.test(draft.envName.trim())) {
    return "Env must be a letter or _ followed by up to 119 letters, digits or _.";
  }
  if (mode === "create" && !draft.value.trim()) return "Value is required when creating a secret.";
  return null;
}

export function buildSecretCatalogSavePayload(
  draft: SecretCatalogFormDraft
): SecretCatalogSavePayload {
  const envName = draft.envName.trim();
  const value = draft.value.trim();
  return {
    secretRef: draft.secretRef.trim(),
    ...(envName ? { envName } : {}),
    description: draft.description.trim() || null,
    access: draft.access,
    ...(value ? { value } : {}),
  };
}

function cleanString(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}
