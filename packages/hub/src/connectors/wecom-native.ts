import { wecomRecipientRef, type WeComInstallation } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorCredentialRepository, connectorWeComCompanyRepository, connectorWeComSuiteRepository } from "./credentials";
import { ProviderRequestError } from "./http";
import { requestWeComSuiteToken, wecomCompanyApi } from "./wecom-company-api";
import { wecomNativeSuite } from "./wecom-suite";
import type { ConnectorActionContext } from "./provider";

export const WECOM_NATIVE_DEPENDENCIES = { native: wecomNativeSuite, companies: connectorWeComCompanyRepository,
  tickets: connectorWeComSuiteRepository, credentials: connectorCredentialRepository,
  suiteToken: requestWeComSuiteToken, client: wecomCompanyApi };
type Native = NonNullable<Awaited<ReturnType<typeof wecomNativeSuite>>>;
export async function wecomStoreClient(env: Env, native: Native, dependencies = WECOM_NATIVE_DEPENDENCIES) {
  const companies = dependencies.companies(env), base = () => ({ requestId: crypto.randomUUID(), app: native.app });
  const cached = await companies.suiteToken(base());
  if ("value" in cached) return dependencies.client(cached.value);
  const ticket = await dependencies.tickets(env).ticket(base());
  const token = await dependencies.suiteToken({ suiteId: native.app.suiteId, suiteSecret: native.suiteSecret, ticket });
  await companies.saveSuiteToken({ ...base(), ...cached, ...token });
  return dependencies.client(token.value);
}
function providerGrant(value: WeComInstallation) {
  return { corpId: value.corpId, permanentCode: value.permanentCode, agentId: value.agentId };
}
export async function wecomActionCapability(env: Env, spaceId: string, authorize: () => Promise<void>,
  dependencies = WECOM_NATIVE_DEPENDENCIES): Promise<NonNullable<ConnectorActionContext["wecom"]>> {
  const native = await dependencies.native(env);
  if (!native) throw new ProviderRequestError(503, "WeCom company application is not configured");
  const companies = dependencies.companies(env);
  const captured = await companies.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId });
  if (!captured) throw new ProviderRequestError(409, "Confirm a WeCom company installation and its members in Apps");
  return { async sendMessage(recipient, text) {
    const pairs = await Promise.all(captured.members.map(async member => ({ member, ref: await wecomRecipientRef(captured, member) })));
    const selected = pairs.find(pair => pair.ref === recipient);
    if (!selected) throw new ProviderRequestError(403, "Choose a WeCom member confirmed for this Space");
    const live = async () => {
      if (!await companies.current({ requestId: crypto.randomUUID(), app: native.app, installation: captured })) {
        throw new ProviderRequestError(409, "WeCom company authorization changed; reconnect");
      }
      await authorize();
    };
    await live();
    const client = await wecomStoreClient(env, native, dependencies);
    await client.send(providerGrant(captured), selected.member, text, live);
  } };
}
export async function verifyWeComNativeConnection(env: Env, spaceId: string, dependencies = WECOM_NATIVE_DEPENDENCIES): Promise<boolean> {
  if (await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "wecom" })) return false;
  const native = await dependencies.native(env); if (!native) return false;
  const companies = dependencies.companies(env);
  const captured = await companies.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
  if (!captured) throw new ProviderRequestError(409, "Confirm a WeCom company installation before checking");
  const client = await wecomStoreClient(env, native, dependencies);
  await client.check(providerGrant(captured), captured.members);
  if (!await companies.current({ requestId: crypto.randomUUID(), app: native.app, installation: captured, forCheck: true })) {
    throw new ProviderRequestError(409, "WeCom company authorization changed during Check");
  }
  return true;
}
