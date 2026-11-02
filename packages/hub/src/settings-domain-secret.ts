import { appViewAddress, type ParsedSettingAddress, type SettingDescriptor, type SpaceSecretEntry } from "@xmatrix/protocol";
import { spaceSecretRepository } from "./index-routes-secrets";
import { SettingWriteRefused, type SettingDomainResolver, type SettingsReader } from "./settings-registry";

/** Where the secret domains read and write, replaceable in tests. */
export interface SecretSettingsPort {
  /** The Space's secrets without values, and whether this reader manages them. */
  list(reader: SettingsReader): Promise<{ secrets: SpaceSecretEntry[]; canManage: boolean }>;
  /** Saves a value; made for an asking Run, that Run may then read it too. */
  save(reader: SettingsReader, secretRef: string, value: string): Promise<void>;
  /** Lets every Run in the Space read the secret without asking. */
  open(reader: SettingsReader, secretRef: string): Promise<void>;
}

const PORT: SecretSettingsPort = {
  async list(reader) {
    try { return await spaceSecretRepository(reader.env).list({ spaceId: reader.spaceId, userId: reader.userId }); }
    // A reader outside the Space's members sees that a secret is asked for, not whether it is saved.
    catch { return { secrets: [], canManage: false }; }
  },
  async save(reader, secretRef, value) {
    const run = reader.asker?.runId && reader.asker.channelId ? reader.asker : undefined;
    if (run) await spaceSecretRepository(reader.env).approve({ userId: reader.userId, runId: run.runId!, channelId: run.channelId!, secretRef, value });
    else await spaceSecretRepository(reader.env).put({ spaceId: reader.spaceId, userId: reader.userId, secretRef, value });
  },
  async open(reader, secretRef) {
    const run = reader.asker?.runId && reader.asker.channelId ? reader.asker : undefined;
    if (run) await spaceSecretRepository(reader.env).makeAutomatic({ userId: reader.userId, runId: run.runId!, channelId: run.channelId!,
      secretRefs: [secretRef] });
    else await spaceSecretRepository(reader.env).put({ spaceId: reader.spaceId, userId: reader.userId, secretRef, access: "auto" });
  },
};

const after = (time: string, since: string | undefined) => !since || Date.parse(time) > Date.parse(since);

/**
 * `secret:<alias>`: a Space secret's value, written once by a Space owner or
 * admin and never read back. It counts once saved since the card asked.
 */
/** Each `secret:` or `secret-access:` address with the saved secret it names, if any, as one domain projects it. */
function secretDomain(port: SecretSettingsPort, project: (input: { address: ParsedSettingAddress; secretRef: string;
  saved?: SpaceSecretEntry; canManage: boolean; reader: SettingsReader }) => SettingDescriptor,
write: SettingDomainResolver["write"]): SettingDomainResolver {
  return {
    async describe(reader, addresses) {
      const { secrets, canManage } = await port.list(reader);
      return addresses.map((address) => {
        const secretRef = address.parts[0]!;
        const saved = secrets.find((secret) => secret.secretRef === secretRef);
        return project({ address, secretRef, canManage, reader, ...(saved ? { saved } : {}) });
      });
    },
    write,
  };
}

/**
 * `secret:<alias>`: a Space secret's value, written once by a Space owner or
 * admin and never read back. It counts once saved since the card asked.
 */
export function secretSettingsDomain(port: SecretSettingsPort = PORT): SettingDomainResolver {
  return secretDomain(port, ({ address, secretRef, saved, canManage, reader }) => ({
    address: address.address, domain: "secret", scope: "Space secrets", label: secretRef,
    ...(saved?.description ? { description: saved.description } : {}),
    control: "secret", sensitivity: "secret", writer: "space-admin", state: saved ? "set" : "missing",
    satisfied: Boolean(saved && after(saved.updatedAt, reader.since)), canWrite: canManage,
    href: appViewAddress(reader.spaceId, "settings", "secrets") }),
  async (reader, address, value) => {
    if (!value?.trim()) throw new SettingWriteRefused("Type the secret's value; clearing one is done in Settings");
    await port.save(reader, address.parts[0]!, value);
  });
}

/**
 * `secret-access:<alias>`: whether Agents read a saved secret without asking
 * first. A Space owner or admin grants it; taking it back is done in Settings.
 */
export function secretAccessSettingsDomain(port: SecretSettingsPort = PORT): SettingDomainResolver {
  return secretDomain(port, ({ address, secretRef, saved, canManage, reader }) => ({
    address: address.address, domain: "secret-access", scope: "Space secrets",
    label: `Agents read ${secretRef} without asking`, control: "grant", sensitivity: "plain", writer: "space-admin",
    state: saved?.access === "auto" ? "set" : "missing", satisfied: saved?.access === "auto", canWrite: canManage && Boolean(saved),
    href: appViewAddress(reader.spaceId, "settings", "secrets"),
    ...(saved || !canManage ? {} : { problem: `${secretRef} is not saved in this Space` }) }),
  async (reader, address, value) => {
    if (value !== "granted") throw new SettingWriteRefused("A secret is opened up with granted; asking again is set in Settings");
    await port.open(reader, address.parts[0]!);
  });
}
