import {
  appViewAddress, connectorAddressFix, connectorFixSettled,
  type ParsedSettingAddress, type SerializedAppConnectorExecution, type SettingDescriptor, type SettingsConnectionState,
  type SettingState,
} from "@xmatrix/protocol";
import { checkAppConnection } from "./app-connection-check";
import { getAppConnectorProvider } from "./app-connectors";
import { connectionUseRefused, listAppConnections, recentAppExecutions, upsertAppConnection } from "./apps";
import { credentialPolicy, readConnectorReadback, saveConnectorCredentials } from "./connectors/credential-policy";
import { connectorCredentialRepository } from "./connectors/credentials";
import { connectorProvider } from "./connectors/registry";
import { recordedRead } from "./index-routes-connector-call";
import { SettingWriteRefused, type SettingDomainResolver, type SettingsReader } from "./settings-registry";

/** Where the connector domain reads and writes, replaceable in tests. */
export interface ConnectorSettingsPort {
  connections(reader: SettingsReader): Promise<Record<string, unknown>[]>;
  /** Plain values for a Space admin; undefined for anyone the store refuses. */
  readback(reader: SettingsReader, providerId: string): Promise<Record<string, string> | undefined>;
  save(reader: SettingsReader, providerId: string, fields: Record<string, string | null>): Promise<void>;
  /** Asks the provider, which is what makes a saved field `verified` or `invalid`. */
  check(reader: SettingsReader, providerId: string): Promise<void>;
  /** The Space's most recent connector calls, newest first: what calls needing a field last did. */
  executions(reader: SettingsReader): Promise<SerializedAppConnectorExecution[]>;
  /** Runs a field's verify read as the writer, recorded in the card's Channel like any read. */
  verify(reader: SettingsReader, providerId: string, actionId: string): Promise<void>;
}

/** How many recent calls a card reads for a field's evidence: one bounded page. */
const RECENT_CALLS = 100;

const PORT: ConnectorSettingsPort = {
  async connections(reader) {
    try { return await listAppConnections(reader.env, { spaceId: reader.spaceId, actorUserId: reader.userId }); }
    // Someone who reads the Channel but not the Space's connections sees that a setting is asked for, not its state.
    catch (error) { if (connectionUseRefused(error)) return []; throw error; }
  },
  async readback(reader, providerId) {
    const policy = credentialPolicy(providerId);
    try {
      if (policy) return await readConnectorReadback(reader.env, { spaceId: reader.spaceId, policy, actorUserId: reader.userId });
      // An App connected by authorizing (GitHub) has no typed field to read back, and a Space admin still connects it.
      await connectorCredentialRepository(reader.env).authorizeAdmin({ requestId: crypto.randomUUID(), spaceId: reader.spaceId,
        actorUserId: reader.userId });
      return {};
    } catch { return undefined; }
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
  async executions(reader) {
    try {
      return await recentAppExecutions(reader.env, { spaceId: reader.spaceId, actorUserId: reader.userId, limit: RECENT_CALLS }) as
        unknown as SerializedAppConnectorExecution[];
    } catch (error) { if (connectionUseRefused(error)) return []; throw error; }
  },
  async verify(reader, providerId, actionId) {
    if (!reader.channelId) return;
    // Its execution and receipt are the evidence; a refusal is recorded there, not thrown at the person.
    await recordedRead(reader.env, { channelId: reader.channelId, spaceId: reader.spaceId, ownerUserId: reader.userId,
      command: `@${providerId}:${actionId}:*`, visibility: "private", authorize: async () => {},
      sender: { kind: "user", id: reader.userId }, principal: { kind: "user", id: reader.userId } }).catch(() => undefined);
  },
};

const EPOCH = new Date(0).toISOString();

/**
 * The latest call that says whether one field works: a call that needed it
 * and ran, or one that stopped on it. Executions come newest first.
 */
function fieldEvidence(executions: readonly SerializedAppConnectorExecution[], providerId: string, field: string):
  SerializedAppConnectorExecution | undefined {
  const actions = connectorProvider(providerId)?.actions ?? {};
  return executions.find((execution) => execution.providerId === providerId && (
    (execution.status === "completed" && Boolean(execution.actionId && actions[execution.actionId]?.requires.includes(field))) ||
    (execution.status !== "completed" && execution.remedy?.kind === "credential" && execution.remedy.field === field)));
}

/**
 * Connector settings: a manifest's typed credential fields and the connection
 * itself (`connector:<app>/connect`). A Space owner or admin makes them. A
 * field counts once the provider check passes after the card asked, unless
 * the manifest names a `verify` read for it: such a field (a web session
 * beside an API key) is proven only by what calls needing it last did, and
 * saving it on a card runs that read.
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
      const fields = fixes.map(({ fix }) => {
        const manifest = getAppConnectorProvider(fix!.providerId)!;
        const field = fix!.remedy.kind === "credential"
          ? manifest.credentials?.find((candidate) => candidate.id === (fix!.remedy as { field: string }).field) : undefined;
        return { manifest, field };
      });
      const executions = fields.some(({ field }) => field?.verify) ? await port.executions(reader) : [];
      return fixes.map(({ address, fix }, index): SettingDescriptor => {
        const { manifest, field } = fields[index]!;
        const connection = connections.find((candidate) => candidate.providerId === fix!.providerId) as
          (SettingsConnectionState & { error?: string }) | undefined;
        const readback = readbacks.get(fix!.providerId);
        const stored = !field || Boolean(connection?.credentialFields?.includes(field.id));
        let state: SettingState = !connection || !stored ? "missing" : connection.status === "error" ? "invalid"
          : connection.status === "configured" && connection.lastCheckedAt ? "verified" : field ? "set" : "missing";
        let satisfied = connectorFixSettled(fix!, connection, reader.since ?? EPOCH);
        let problem = state === "invalid" ? connection?.error : undefined;
        if (field?.verify && stored) {
          // The connection check never exercised this field: only its calls say whether it works.
          const evidence = fieldEvidence(executions, manifest.id, field.id);
          state = evidence?.status === "completed" ? "verified" : evidence ? "invalid" : "set";
          satisfied = evidence?.status === "completed" && Date.parse(evidence.updatedAt) > Date.parse(reader.since ?? EPOCH);
          problem = evidence && evidence.status !== "completed" ? evidence.reason : undefined;
        }
        return {
          address: address.address, domain: "connector", scope: manifest.name,
          label: field?.label ?? "Connection", ...(field?.description ? { description: field.description } : {}),
          control: !field ? "connect" : field.signIn ? "sign-in" : field.plain ? "text" : "secret",
          sensitivity: field?.plain ? "plain" : "secret", writer: "space-admin", state, satisfied,
          canWrite: readback !== undefined,
          ...(field?.plain && readback?.[field.id] ? { value: readback[field.id] } : {}),
          ...(field?.signIn ? { service: field.signIn } : {}),
          href: appViewAddress(reader.spaceId, "apps", manifest.id),
          ...(problem ? { problem } : {}),
        };
      });
    },
    async write(reader, address: ParsedSettingAddress, value) {
      const fix = connectorAddressFix(address);
      const remedy = fix?.remedy;
      if (!fix || remedy?.kind !== "credential") throw new SettingWriteRefused(`${address.address} is connected in Apps, not typed`);
      await port.save(reader, fix.providerId, { [remedy.field]: value?.trim() || null });
      await port.check(reader, fix.providerId);
      const field = getAppConnectorProvider(fix.providerId)?.credentials?.find((candidate) => candidate.id === remedy.field);
      if (field?.verify && value?.trim()) await port.verify(reader, fix.providerId, field.verify);
    },
  };
}
