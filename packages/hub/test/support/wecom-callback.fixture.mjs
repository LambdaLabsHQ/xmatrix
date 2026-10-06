import { createCipheriv, createHash } from "node:crypto";
import { wecomNativeSuite } from "../../src/connectors/wecom-suite.ts";
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
export const env = { CONNECTOR_WECOM_SUITE_ID: "ww0123456789abcdef", CONNECTOR_WECOM_SUITE_SECRET: "public_fixture_secret",
  CONNECTOR_WECOM_CALLBACK_TOKEN: "PublicFixtureToken", CONNECTOR_WECOM_ENCODING_AES_KEY: key.toString("base64").slice(0,-1) };
export const native = await wecomNativeSuite(env);
export const seconds = () => String(Math.floor(Date.now()/1000));
export function encrypted(message, receiver = native.app.suiteId, mutate = bytes => bytes, corruptPadding = false) {
  const body = Buffer.isBuffer(message) ? message : Buffer.from(message), length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const bytes = mutate(Buffer.concat([Buffer.alloc(16,17), length, body, Buffer.from(receiver)]));
  const padding = 32 - bytes.length % 32;
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0,16)); cipher.setAutoPadding(false);
  const padded=Buffer.concat([bytes,Buffer.alloc(padding,padding)]);if(corruptPadding)padded[padded.length-2]^=1;
  return Buffer.concat([cipher.update(padded),cipher.final()]).toString("base64");
}
export function url(ciphertext, timestamp = seconds(), token = native.token) {
  const nonce = "123456", signature = createHash("sha1").update([token,timestamp,nonce,ciphertext].sort().join("")).digest("hex");
  return `https://hub.example.test/api/connectors/wecom/suite?${new URLSearchParams({ msg_signature: signature, timestamp, nonce })}`;
}
export const xml = (fields) => `<xml>${Object.entries(fields).map(([name,value]) => `<${name}><![CDATA[${value}]]></${name}>`).join("")}</xml>`;
export const payload = (changes = {}) => ({ SuiteId: native.app.suiteId, InfoType: "suite_ticket", TimeStamp: seconds(), SuiteTicket: "private-fixture-ticket", ...changes });
export const post = (plaintext, envelope = {}) => { const cipher = encrypted(plaintext); return new Request(url(cipher), { method:"POST",body:xml({ Encrypt:cipher,...envelope }) }); };
