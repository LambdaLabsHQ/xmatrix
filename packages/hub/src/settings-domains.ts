import { admissionSettingsDomain } from "./settings-domain-admission";
import { connectorSettingsDomain } from "./settings-domain-connector";
import { harnessSettingsDomain } from "./settings-domain-harness";
import { secretAccessSettingsDomain, secretSettingsDomain } from "./settings-domain-secret";
import type { SettingDomainResolvers } from "./settings-registry";

/** Every domain a setting address may name, each reading its own authority. */
export const SETTING_DOMAIN_RESOLVERS: SettingDomainResolvers = {
  connector: connectorSettingsDomain(),
  secret: secretSettingsDomain(),
  "secret-access": secretAccessSettingsDomain(),
  admission: admissionSettingsDomain(),
  harness: harnessSettingsDomain(),
};
