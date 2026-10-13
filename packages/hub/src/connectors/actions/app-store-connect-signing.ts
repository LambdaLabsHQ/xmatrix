import { appStoreConnect, appleResource, BUNDLE_ID, relatedIds, relation, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText } from "./common";
import { cell, keyedOptions } from "./google-report";

/*
 * Code signing for distribution without an Apple ID on the build machine: the
 * machine makes a private key and a certificate signing request, and only the
 * request comes here. Apple answers with the certificate; a provisioning
 * profile ties it to the bundle ID. Both are public documents, read back with
 * `read_certificate` and `read_profile`; the private key never leaves the
 * machine that made it.
 *
 * A team holds only a few distribution certificates. `create_certificate`
 * creates one per call and is never retried here; nothing in this connector
 * revokes a certificate or deletes a profile.
 */

const CERTIFICATE_TYPES: Readonly<Record<string, string>> = { distribution: "DISTRIBUTION", ios_distribution: "IOS_DISTRIBUTION",
  mac_app_distribution: "MAC_APP_DISTRIBUTION", mac_installer_distribution: "MAC_INSTALLER_DISTRIBUTION" };
const PROFILE_TYPES: Readonly<Record<string, string>> = { ios: "IOS_APP_STORE", macos: "MAC_APP_STORE", tvos: "TVOS_APP_STORE", catalyst: "MAC_CATALYST_APP_STORE" };
const BUNDLE_PLATFORMS: Readonly<Record<string, string>> = { ios: "IOS", macos: "MAC_OS", universal: "UNIVERSAL" };
const CAPABILITIES = ["ICLOUD", "IN_APP_PURCHASE", "GAME_CENTER", "PUSH_NOTIFICATIONS", "WALLET", "INTER_APP_AUDIO", "MAPS", "ASSOCIATED_DOMAINS", "PERSONAL_VPN",
  "APP_GROUPS", "HEALTHKIT", "HOMEKIT", "WIRELESS_ACCESSORY_CONFIGURATION", "APPLE_PAY", "DATA_PROTECTION", "SIRIKIT", "NETWORK_EXTENSIONS", "MULTIPATH", "HOT_SPOT",
  "NFC_TAG_READING", "CLASSKIT", "AUTOFILL_CREDENTIAL_PROVIDER", "ACCESS_WIFI_INFORMATION", "NETWORK_CUSTOM_PROTOCOL", "COREMEDIA_HLS_LOW_LATENCY",
  "SYSTEM_EXTENSION_INSTALL", "USER_MANAGEMENT", "APPLE_ID_AUTH"];
const RESOURCE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;
const day = (value: unknown) => text(value).slice(0, 10);

/** The registered bundle ID with exactly this identifier; Apple's own filter also matches longer ones. */
async function registeredBundle(api: AppStoreConnectApi, identifier: string): Promise<{ bundle?: AppleResource; included: AppleResource[] }> {
  const { rows, included } = await api.list("/v1/bundleIds", { "filter[identifier]": identifier, include: "bundleIdCapabilities", limit: "200",
    "fields[bundleIds]": "name,platform,identifier,seedId,bundleIdCapabilities", "fields[bundleIdCapabilities]": "capabilityType" });
  return { bundle: rows.find(row => text(row.attributes.identifier).toLowerCase() === identifier.toLowerCase()), included };
}

async function requiredBundle(api: AppStoreConnectApi, identifier: string): Promise<AppleResource> {
  const { bundle } = await registeredBundle(api, identifier);
  if (!bundle) throw new ProviderRequestError(404, `${identifier} is not a registered bundle ID; run register_bundle_id first`);
  return bundle;
}

/** A certificate signing request as its base64 body, whether pasted with its armor and line breaks or without. */
function requestBody(pasted: string): string | undefined {
  const body = pasted.replace(/-----[A-Z ]+-----/gu, "").replace(/\s+/gu, "");
  return /^[A-Za-z0-9+/]{400,6000}={0,2}$/u.test(body) ? body : undefined;
}

/** One public document, base64 as Apple returns it, fenced so it cannot be read as anything else. */
function document(what: string, lines: string[], content: unknown): string {
  const body = text(content);
  if (!/^[A-Za-z0-9+/=\s]{100,200000}$/u.test(body)) throw new ProviderRequestError(502, `App Store Connect did not return the ${what}'s content`);
  return `${lines.join("; ")}. Its content, base64:\n${quoteRetrievedText(body.replace(/\s+/gu, ""))}`;
}

export const APP_STORE_CONNECT_SIGNING_ACTIONS: Record<string, ConnectorAction> = {
  signing: {
    effect: "read", requires: ["keyId", "privateKey"],
    parse: statement => BUNDLE_ID.test(statement.target) && !statement.text.trim() ? { identifier: statement.target } : "name a bundle ID: <com.example.app>",
    async execute({ credentials }, input) {
      const api = appStoreConnect(credentials);
      const [{ bundle, included }, certificates] = await Promise.all([registeredBundle(api, input.identifier!),
        api.list("/v1/certificates", { "filter[certificateType]": Object.values(CERTIFICATE_TYPES).join(","), limit: "50",
          "fields[certificates]": "name,certificateType,serialNumber,expirationDate" }, 1)]);
      const profiles = bundle ? (await api.list(`/v1/bundleIds/${encodeURIComponent(bundle.id)}/profiles`,
        { "fields[profiles]": "name,profileType,profileState,uuid,expirationDate", limit: "50" }, 1)).rows : [];
      const capabilities = bundle ? relatedIds(bundle, "bundleIdCapabilities").flatMap(id => cell(included.find(row => row.id === id)?.attributes.capabilityType) || []) : [];
      const lines = [bundle ? `bundle ID: ${cell(bundle.attributes.identifier)} (${cell(bundle.attributes.name)}, ${cell(bundle.attributes.platform)}), capabilities: ${capabilities.join(", ") || "none"}`
        : "bundle ID: not registered",
      "distribution certificates:", ...(certificates.rows.length ? certificates.rows.map(row => `  ${row.id}\t${cell(row.attributes.certificateType)}\t${cell(row.attributes.name)}` +
        `\tserial ${cell(row.attributes.serialNumber)}\texpires ${day(row.attributes.expirationDate)}`) : ["  none"]),
      "profiles for this bundle ID:", ...(profiles.length ? profiles.map(row => `  ${row.id}\t${cell(row.attributes.profileType)}\t${cell(row.attributes.name)}` +
        `\t${cell(row.attributes.profileState)}\texpires ${day(row.attributes.expirationDate)}`) : ["  none"])];
      return { summary: `Signing setup for ${input.identifier}:\n` + quoteRetrievedText(lines.join("\n")) };
    },
  },
  register_bundle_id: {
    effect: "write", requires: ["keyId", "privateKey"],
    parse(statement) {
      const usage = "name the bundle ID and what to call it: <com.example.app> <Example App> [platform=ios|macos|universal]";
      const words = statement.text.trim().split(/\s+/u).filter(Boolean);
      const options = keyedOptions(words.filter(word => word.includes("=")).join(" "), ["platform"], usage);
      const name = words.filter(word => !word.includes("=")).join(" ");
      const platform = typeof options === "string" ? undefined : BUNDLE_PLATFORMS[options.get("platform") ?? "ios"];
      return BUNDLE_ID.test(statement.target) && NAME.test(name) && platform ? { identifier: statement.target, name, platform } : usage;
    },
    async execute({ credentials }, input) {
      const api = appStoreConnect(credentials);
      const { bundle } = await registeredBundle(api, input.identifier!);
      if (bundle) return { summary: `${input.identifier} is already registered (${cell(bundle.attributes.name)}, ${cell(bundle.attributes.platform)}).` };
      await api.request("/v1/bundleIds", { method: "POST", data: { type: "bundleIds", attributes: { identifier: input.identifier, name: input.name, platform: input.platform } } });
      return { summary: `Registered bundle ID ${input.identifier} (${input.platform}). Creating the app record with it is still done in App Store Connect.` };
    },
  },
  enable_capability: {
    effect: "write", requires: ["keyId", "privateKey"],
    parse(statement) {
      const capability = statement.text.trim().toUpperCase();
      return BUNDLE_ID.test(statement.target) && CAPABILITIES.includes(capability) ? { identifier: statement.target, capability }
        : `name a bundle ID and one capability: <com.example.app> <${CAPABILITIES.slice(0, 5).join("|")}|…>`;
    },
    async execute({ credentials }, input) {
      const api = appStoreConnect(credentials);
      const bundle = await requiredBundle(api, input.identifier!);
      await api.request("/v1/bundleIdCapabilities", { method: "POST", data: { type: "bundleIdCapabilities", attributes: { capabilityType: input.capability },
        relationships: { bundleId: relation("bundleIds", bundle.id) } } });
      return { summary: `Enabled ${input.capability} for ${input.identifier}. Profiles created before this do not carry it; create a new profile.` };
    },
  },
  create_certificate: {
    effect: "write", requires: ["keyId", "privateKey"],
    parse(statement) {
      const type = CERTIFICATE_TYPES[statement.target.toLowerCase()], request = requestBody(statement.text);
      return type && request ? { type, request }
        : `name the certificate type and paste the signing request the build machine made: <${Object.keys(CERTIFICATE_TYPES).join("|")}> <-----BEGIN CERTIFICATE REQUEST----- …>`;
    },
    async execute({ credentials }, input) {
      const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${input.request!.match(/.{1,64}/gu)!.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
      const created = appleResource((await appStoreConnect(credentials).request("/v1/certificates", { method: "POST",
        data: { type: "certificates", attributes: { certificateType: input.type, csrContent: pem } } })).data);
      if (!created) throw new ProviderRequestError(502, "App Store Connect did not return the certificate");
      return { summary: `Created ${input.type} certificate ${created.id}, serial ${cell(created.attributes.serialNumber)}, expires ${day(created.attributes.expirationDate)}. ` +
        `It works only with the private key that made the request. Fetch it with @appstoreconnect:read_certificate:${created.id}. A team holds only a few of these.` };
    },
  },
  read_certificate: {
    effect: "read", requires: ["keyId", "privateKey"],
    parse: statement => RESOURCE_ID.test(statement.target) && !statement.text.trim() ? { id: statement.target } : "name a certificate id from signing: <certificate id>",
    async execute({ credentials }, input) {
      const certificate = appleResource((await appStoreConnect(credentials).request(`/v1/certificates/${encodeURIComponent(input.id!)}`,
        { query: { "fields[certificates]": "name,certificateType,serialNumber,expirationDate,certificateContent" } })).data);
      return { summary: document("certificate", [`Certificate ${input.id}: ${cell(certificate?.attributes.certificateType)}, ${cell(certificate?.attributes.name)}`,
        `serial ${cell(certificate?.attributes.serialNumber)}`, `expires ${day(certificate?.attributes.expirationDate)}`], certificate?.attributes.certificateContent) };
    },
  },
  create_profile: {
    effect: "write", requires: ["keyId", "privateKey"],
    parse(statement) {
      const usage = "name a bundle ID, the distribution certificate to sign with and the store: <com.example.app> <certificate id> [store=ios|macos|tvos|catalyst]";
      const [certificate = "", ...rest] = statement.text.trim().split(/\s+/u);
      const options = keyedOptions(rest.join(" "), ["store"], usage);
      const type = typeof options === "string" ? undefined : PROFILE_TYPES[options.get("store") ?? "ios"];
      return BUNDLE_ID.test(statement.target) && RESOURCE_ID.test(certificate) && type ? { identifier: statement.target, certificate, type } : usage;
    },
    async execute({ credentials }, input) {
      const api = appStoreConnect(credentials);
      const bundle = await requiredBundle(api, input.identifier!);
      const created = appleResource((await api.request("/v1/profiles", { method: "POST", data: { type: "profiles",
        attributes: { name: `xMatrix ${input.identifier} ${input.type}`.slice(0, 80), profileType: input.type },
        relationships: { bundleId: relation("bundleIds", bundle.id), certificates: { data: [{ type: "certificates", id: input.certificate }] } } } })).data);
      if (!created) throw new ProviderRequestError(502, "App Store Connect did not return the profile");
      return { summary: `Created ${input.type} profile ${created.id} (${cell(created.attributes.name)}, UUID ${cell(created.attributes.uuid)}) for ${input.identifier}, ` +
        `expires ${day(created.attributes.expirationDate)}. Fetch it with @appstoreconnect:read_profile:${created.id}.` };
    },
  },
  read_profile: {
    effect: "read", requires: ["keyId", "privateKey"],
    parse: statement => RESOURCE_ID.test(statement.target) && !statement.text.trim() ? { id: statement.target } : "name a profile id from signing: <profile id>",
    async execute({ credentials }, input) {
      const profile = appleResource((await appStoreConnect(credentials).request(`/v1/profiles/${encodeURIComponent(input.id!)}`,
        { query: { "fields[profiles]": "name,profileType,profileState,uuid,expirationDate,profileContent" } }).catch((error: unknown) => {
        /* Apple lists the profiles Xcode manages for a bundle ID but answers 404 when one is read. */
        if (!(error instanceof ProviderRequestError) || error.status !== 404) throw error;
        throw new ProviderRequestError(404, `${error.message} A profile Xcode manages is listed by signing but cannot be read; create one with create_profile`);
      })).data);
      return { summary: document("profile", [`Profile ${input.id}: ${cell(profile?.attributes.profileType)}, ${cell(profile?.attributes.name)}`,
        `UUID ${cell(profile?.attributes.uuid)}`, `${cell(profile?.attributes.profileState)}, expires ${day(profile?.attributes.expirationDate)}`], profile?.attributes.profileContent) };
    },
  },
};
