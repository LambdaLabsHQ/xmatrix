import {
  appViewAddress, connectorAddressFix, connectorFixSettled,
  type ParsedSettingAddress, type SettingDescriptor, type SettingsConnectionState,
} from "@xmatrix/protocol";
import { checkAppConnection } from "./app-connection-check";
import { getAppConnectorProvider } from "./app-connectors";
import { listAppConnections, upsertAppConnection } from "./apps";
import { credentialPolicy, readConnectorReadback, saveConnectorCredentials } from "./connectors/credential-policy";
import { SettingWriteRefused, type SettingDomainResolver, type SettingsReader } from "./settings-registry";

/** Where the connector domain reads and writes, replaceable in tests. */
export interface ConnectorSettingsPort {
  connections(reader: SettingsReader): Promise<Record<string, unknown>[]>;
  /** Plain values for a Space admin; undefined for anyone the store refuses. */
  readback(reader: SettingsReader, providerId: string): Promise<Record<string, string> | undefined>;
  save(reader: SettingsReader, providerId: string, fields: Record<string, string | null>): Promise<void>;
  /** Asks the provider, which is what makes a saved field `verified` or `invalid`. */
  check(reader: SettingsReader, providerId: string): Promise<void>;
}

const PORT: ConnectorSettingsPort = {
  connections: (reader) => listAppConnections(reader.env, { spaceId: reader.spaceId, actorUserId: reader.userId }),
  async readback(reader, providerId) {
    const policy = credentialPolicy(providerId);
    if (!policy) return undefined;
    try { return await readConnectorReadback(reader.env, { spaceId: reader.spaceId, policy, actorUserId: reader.userId }); }
    catch { return undefined; }
  },
  async save(reader, providerId, fields) {
    const policy = credentialPolicy(providerId)!;
    const connections = await PORT.connections(reader);
    // A setting may be asked for an App not connected yet: its credentials need the connection first.
    if (!connections.some((connection) => connection.providerId === providerId)) {
      await upsertAppConnection(reader.env, { commandId: `settings-connect:${crypto.randomUUID()}`, spaceId: reader.spaceId,
        actorUserId: reader.userId, providerId,
        body: { providerId, providerName: policy.manifest.name, status: "disconnected" } });
    }
    await saveConnectorCredentials(reader.env, { spaceId: reader.spaceId, policy, actorUserId: reader.userId, fields });
  },
  async check(reader, providerId) {
    await checkAppConnection(reader.env, { spaceId: reader.spaceId, providerId, userId: reader.userId,
      commandId: `settings-check:${crypto.randomUUID()}` });
  },
};

const EPOCH = new Date(0).toISOString();

/**
 * Connector settings: a manifest's typed credential fields and the connection
 * itself (`connector:<app>/connect`). A Space owner or admin makes them; a
 * saved field counts once the provider check passes after the card asked.
 */
export function connectorSettingsDomain(port: ConnectorSettingsPort = PORT): SettingDomainResolver {
  return {
    async describe(reader, addresses) {
      const fixes = addresses.map((address) => ({ address, fix: connectorAddressFix(address) }));
      const unknown = fixes.find((item) => !item.fix);
      if (unknown) return `${unknown.address.address} names no field a person writes; connector:<app>/<field> takes a field from the App's credentials`;
      const connections = await port.connections(reader);
      const readbacks = new Map<string, Record<string, string> | undefined>();
      for (const { fix } of fixes) {
        if (!readbacks.has(fix!.providerId)) readbacks.set(fix!.providerId, await port.readback(reader, fix!.providerId));
      }
      return fixes.map(({ address, fix }): SettingDescriptor => {
        const manifest = getAppConnectorProvider(fix!.providerId)!;
        const connection = connections.find((candidate) => candidate.providerId === fix!.providerId) as
          (SettingsConnectionState & { error?: string }) | undefined;
        const readback = readbacks.get(fix!.providerId);
        const field = fix!.remedy.kind === "credential"
          ? manifest.credentials?.find((candidate) => candidate.id === (fix!.remedy as { field: string }).field) : undefined;
        const stored = !field || Boolean(connection?.credentialFields?.includes(field.id));
        const state = !connection || !stored ? "missing" : connection.status === "error" ? "invalid"
          : connection.status === "configured" && connection.lastCheckedAt ? "verified" : field ? "set" : "missing";
        return {
          address: address.address, domain: "connector", scope: manifest.name,
          label: field?.label ?? "Connection", ...(field?.description ? { description: field.description } : {}),
          control: !field ? "connect" : field.signIn ? "sign-in" : field.plain ? "text" : "secret",
          sensitivity: field?.plain ? "plain" : "secret", writer: "space-admin", state,
          satisfied: connectorFixSettled(fix!, connection, reader.since ?? EPOCH),
          canWrite: readback !== undefined,
          ...(field?.plain && readback?.[field.id] ? { value: readback[field.id] } : {}),
          ...(field?.signIn ? { service: field.signIn } : {}),
          href: appViewAddress(reader.spaceId, "apps", manifest.id),
          ...(state === "invalid" && connection?.error ? { problem: connection.error } : {}),
        };
      });
    },
    async write(reader, address: ParsedSettingAddress, value) {
      const fix = connectorAddressFix(address);
      if (fix?.remedy.kind !== "credential") throw new SettingWriteRefused(`${address.address} is connected in Apps, not typed`);
      await port.save(reader, fix.providerId, { [fix.remedy.field]: value?.trim() || null });
      await port.check(reader, fix.providerId);
    },
  };
}
