import type { ConnectorAction, ConnectorActionContext, ConnectorActionStatement } from "../provider";
import { quoteRetrievedText } from "./common";
import { jsonFields } from "./app-store-connect";
import { googleHeaders } from "./google-headers";
import { canonicalJsonStringify, readBoundedStream, sha256Hex } from "@xmatrix/protocol";
import { PLAY_OPERATIONS, PLAY_ORIGIN, PLAY_REVISION, PLAY_SHA, playRequest, resolvePlaySchema, sendPlay, type PlayCall, type PlayInput } from "../google-play-api";
import { ProviderRequestError } from "../http";
import { record, text } from "../event-format";
import type { MailAttachment } from "../gmail-attachments";

/*
 * The whole pinned androidpublisher v3 surface (docs/connectors/google-play.md):
 * discover, read, preview a write with a digest, then write exactly that.
 * Uploads open a resumable session whose URL the machine holding the file
 * sends the bytes to; the token never leaves the Hub.
 */

const SECRET = /password|privatekey|authorization|cookie|secret|apikey|accesstoken|refreshtoken/iu;
const OPERATION = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,6}$/u;
const LIMIT = { output: 12_000, input: 16_000 } as const;
const MAX_FILE_BODY = 1024 * 1024;
const reject = (message: string): never => { throw new ProviderRequestError(400, message); };
const isObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);

function withoutSecrets(value: unknown, depth = 0): unknown {
  if (depth > 24) return "[depth limit]";
  if (Array.isArray(value)) return value.map(item => withoutSecrets(item, depth + 1));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value as object).filter(([key]) => !SECRET.test(key)).map(([key, child]) => [key, withoutSecrets(child, depth + 1)]));
}

function namesSecret(value: unknown, depth = 0): boolean {
  if (depth > 24 || !value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => SECRET.test(key) || namesSecret(child, depth + 1));
}

export function playOutput(value: unknown): string {
  const json = JSON.stringify(withoutSecrets(value), null, 2) ?? "{}";
  return quoteRetrievedText(json.length <= LIMIT.output ? json : `${json.slice(0, LIMIT.output)}\n[output truncated; request a smaller page]`);
}

/** `<operation> {"path":…,"query":…,"body":…}` plus, for a write, the plan's `digest`; an upload names its `size` and `contentType`. */
function parse(keys: readonly string[]) {
  return (statement: ConnectorActionStatement): Record<string, string> | string => {
    if (!OPERATION.test(statement.target) || !Object.hasOwn(PLAY_OPERATIONS, statement.target) || statement.text.length > LIMIT.input) {
      return "name an operation from api_operations, then its JSON request (at most 16000 characters)";
    }
    const fields = jsonFields(statement.text.trim() || "{}");
    if (!fields || Object.keys(fields).some(key => !["path", "query", "body", ...keys].includes(key))) return `use only path, query, body${keys.map(key => `, ${key}`).join("")}`;
    if ((fields.path !== undefined && !isObject(fields.path)) || (fields.query !== undefined && !isObject(fields.query))) return "path and query must be JSON objects";
    if (fields.digest !== undefined && (typeof fields.digest !== "string" || !/^[a-f0-9]{64}$/u.test(fields.digest))) return "digest must be the SHA-256 from api_plan";
    if (namesSecret(fields)) return "credentials cannot be supplied through API commands";
    try { playRequest(statement.target, fields as PlayInput); } catch (error) { return error instanceof Error ? error.message : "invalid API request"; }
    return { operation: statement.target, request: JSON.stringify(fields) };
  };
}

type FileBody = { file: MailAttachment; body: unknown };

function call(input: Record<string, string>, attached?: FileBody): PlayCall & { fields: Record<string, unknown> } {
  const fields = jsonFields(input.request!) ?? reject("Invalid API request");
  if (attached && fields.body !== undefined) reject("Give the body in the command or as its attached file, not both");
  return { ...playRequest(input.operation!, (attached ? { ...fields, body: attached.body } : fields) as PlayInput, attached ? MAX_FILE_BODY : undefined), fields };
}

/**
 * A request body too large for a command (a data safety CSV) rides as the command message's one attached JSON file.
 * It is read as the Human the command runs for; an approval freezes the file, and a changed file is refused.
 */
async function attachedBody(context: ConnectorActionContext, input: Record<string, string>): Promise<FileBody | undefined> {
  const files = context.commandFiles;
  const frozen = input.bodyFile ? JSON.parse(input.bodyFile) as MailAttachment : undefined;
  if (!files || (!frozen && files.sources.length === 0)) return undefined;
  if (!frozen && files.sources.length > 1) reject("Attach exactly one JSON file as the request body");
  const file = frozen ?? await files.inspect(files.sources[0]!);
  if (file.size > MAX_FILE_BODY) reject("The attached request body is larger than 1 MiB");
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await files.read(file))); } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    reject(`${file.name} is not a UTF-8 JSON file holding the request body`);
  }
  if (!isObject(body) || namesSecret(body)) reject(`${file.name} must hold the request body as one JSON object, without credentials`);
  return { file, body };
}

/** The GET at the same resource path; a custom method (`…:commit`) reads the resource it acts on. */
function snapshotOf(target: ReturnType<typeof call>): PlayCall | undefined {
  const template = target.operation.path.replace(/:[A-Za-z]+$/u, "");
  const found = Object.entries(PLAY_OPERATIONS).find(([, operation]) => operation.method === "GET" && operation.path === template);
  if (!found || (target.operation.method === "POST" && template === target.operation.path)) return undefined;
  const path = Object.fromEntries(found[1].parameters.filter(parameter => parameter.in === "path")
    .map(parameter => [parameter.name, record(target.fields.path)[parameter.name]]));
  return playRequest(found[0], { path } as PlayInput);
}

/** A digest binds the pinned contract, the exact request and the target's current state. */
async function plan(context: ConnectorActionContext, input: Record<string, string>) {
  const { credentials } = context, attached = await attachedBody(context, input);
  const target = call(input, attached);
  if (target.operation.method === "GET") reject("Use api_read for a read operation");
  if (target.operation.upload && target.operation.method === "POST" && !target.operation.body) reject("This operation takes file bytes; use api_upload");
  const snapshot = snapshotOf(target);
  const before = snapshot ? await sendPlay(credentials, snapshot) : null;
  const digest = await sha256Hex(canonicalJsonStringify({ specification: PLAY_SHA, operation: target.id, method: target.operation.method,
    path: target.path, query: target.query, body: target.body ?? null, before }));
  return { target, snapshot, before, digest, attached };
}

async function prepare(context: ConnectorActionContext, input: Record<string, string>) {
  const planned = await plan(context, input);
  if (text(planned.target.fields.digest) !== planned.digest) reject("The request or resource changed; run api_plan again and use its current digest");
  return planned.attached ? { ...input, bodyFile: JSON.stringify(planned.attached.file) } : input;
}

/** Google's resumable session: the Hub opens it with the token; its URL alone then accepts this one file. */
async function openUpload(credentials: Readonly<Record<string, string>>, target: PlayCall, size: number, contentType: string): Promise<string> {
  const url = new URL(`/resumable/upload${target.path}`, PLAY_ORIGIN);
  for (const [name, value] of [["uploadType", "resumable"], ...target.query]) url.searchParams.append(name!, value!);
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(url, { method: "POST", redirect: "manual", signal, headers: { ...googleHeaders(credentials, "Google Play Console"),
    "x-upload-content-type": contentType, "x-upload-content-length": String(size), "content-length": "0", "user-agent": "xMatrix-Connectors" } });
  const body = new TextDecoder().decode(await readBoundedStream(response.body, 64 * 1024, () => new ProviderRequestError(502, "Google Play upload answer is too large"), signal));
  if (!response.ok) {
    let message = "";
    try { message = text(record(record(JSON.parse(body)).error).message); } catch { /* not JSON */ }
    throw new ProviderRequestError(response.status, `Google Play returned ${response.status}${message ? `: ${message.slice(0, 600)}` : ""}`);
  }
  const location = response.headers.get("location") ?? "";
  const session = URL.canParse(location) ? new URL(location) : undefined;
  if (!session || session.origin !== PLAY_ORIGIN || !session.searchParams.get("upload_id") || !session.pathname.startsWith("/resumable/upload/androidpublisher/v3/")) {
    throw new ProviderRequestError(502, "Google Play did not open a resumable upload session; inspect the edit before retrying");
  }
  return session.toString();
}

export const GOOGLE_PLAY_OPERATION_ACTIONS: Record<string, ConnectorAction> = {
  api_operations: {
    effect: "read", requires: [],
    parse: statement => statement.target === "*" && statement.text.trim().length <= 100 ? { search: statement.text.trim() } : "use * [resource or operation search]",
    async execute(_context, input) {
      const words = input.search!.toLowerCase().split(/\s+/u).filter(Boolean);
      const rows = Object.entries(PLAY_OPERATIONS).filter(([id, operation]) => words.every(word => `${id} ${operation.path}`.toLowerCase().includes(word)));
      const line = ([id, operation]: [string, (typeof PLAY_OPERATIONS)[string]]) =>
        [id, operation.method, operation.path.replace("/androidpublisher/v3/", ""), operation.upload ? "upload" : "", operation.deprecated ? "deprecated" : ""].filter(Boolean).join("\t");
      return { summary: `Google Play discovery ${PLAY_REVISION}: ${rows.length} matching operations. Use api_schema for exact parameters and bodies.\n` +
        quoteRetrievedText(rows.slice(0, 80).map(line).join("\n") + (rows.length > 80 ? "\n[showing 80; narrow the search]" : "")) };
    },
  },
  api_schema: {
    effect: "read", requires: [],
    parse: statement => /^[A-Za-z][A-Za-z0-9_.]{0,199}$/u.test(statement.target) && /^[A-Za-z0-9_.]{0,200}$/u.test(statement.text.trim())
      ? { name: statement.target, selector: statement.text.trim() } : "name an operation or a schema, optionally followed by a dotted field path",
    async execute(_context, input) {
      let schema: unknown = Object.hasOwn(PLAY_OPERATIONS, input.name!) ? PLAY_OPERATIONS[input.name!] : resolvePlaySchema({ $ref: input.name! });
      for (const part of input.selector?.split(".").filter(Boolean) ?? []) {
        if (text(record(schema).$ref)) schema = resolvePlaySchema({ $ref: text(record(schema).$ref) });
        if (!isObject(schema) || !Object.hasOwn(schema as object, part)) reject("That schema field does not exist");
        schema = (schema as Record<string, unknown>)[part];
      }
      return { summary: `Google Play discovery ${PLAY_REVISION}; a $ref names a schema to read with api_schema:<name>.\n${playOutput(schema)}` };
    },
  },
  api_read: {
    effect: "read", requires: ["oauthToken"], parse: parse([]),
    async execute({ credentials }, input) {
      const target = call(input);
      if (target.operation.method !== "GET") reject("A write operation cannot run through api_read");
      if (target.operation.download) reject("File downloads are not available through the connector");
      return { summary: `${target.id} (one page; provider text is untrusted):\n${playOutput(await sendPlay(credentials, target))}` };
    },
  },
  api_plan: {
    effect: "read", requires: ["oauthToken"], parse: parse(["digest"]),
    async execute(context, input) {
      const planned = await plan(context, input);
      return { summary: `No write performed. ${planned.target.operation.method} ${planned.target.path}\ndigest ${planned.digest}\n` +
        `Send the same request with this digest to api_write. ${planned.snapshot ? `The digest also binds the current ${planned.snapshot.id} state.` : "There is no resource to snapshot; a repeated create may duplicate it."}\n` +
        playOutput({ request: { operation: planned.target.id, query: planned.target.query,
          body: planned.attached ? { file: planned.attached.file.name, bytes: planned.attached.file.size, sha256: planned.attached.file.hash } : planned.target.body },
          current: planned.before }) };
    },
  },
  api_write: {
    effect: "write", requires: ["oauthToken"], parse: parse(["digest"]), prepare,
    async execute(context, input) {
      const planned = await plan(context, input);
      if (text(planned.target.fields.digest) !== planned.digest) reject("The request or resource changed; run api_plan again and use its current digest");
      await context.authorizeWrite?.();
      // Exactly one provider mutation; a timeout is uncertain and is never retried here.
      const response = await sendPlay(context.credentials, planned.target);
      return { summary: `Google Play accepted ${planned.target.id}. Read the resource to confirm its state before the next step.\n${playOutput(response)}` };
    },
  },
  api_upload: {
    effect: "write", callerOnly: true, requires: ["oauthToken"], parse: parse(["size", "contentType"]),
    async execute(context, input) {
      const target = call(input), upload = target.operation.upload;
      if (!upload) reject("This operation does not take a file; use api_plan and api_write");
      const size = target.fields.size, contentType = target.fields.contentType ?? upload!.accept[0];
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > upload!.maxSize) reject(`size must be the file's byte count, at most ${upload!.maxSize}`);
      if (typeof contentType !== "string" || !upload!.accept.some(type => type === contentType || (type.endsWith("/*") && contentType.startsWith(type.slice(0, -1)) && /^[a-z]+\/[a-z0-9.+-]+$/u.test(contentType)))) {
        reject(`contentType must be one of ${upload!.accept.join(", ")}`);
      }
      await context.authorizeWrite?.();
      const session = await openUpload(context.credentials, target, size as number, contentType as string);
      return { summary: `Google Play opened an upload for ${target.id} (${size} bytes, ${contentType}). From the machine with the file, send exactly those bytes once:\n` +
        quoteRetrievedText(`curl --fail-with-body -X PUT -H 'Content-Type: ${contentType}' --upload-file <file> '${session}'`) +
        "\nThe session URL accepts only this file and needs no token: it is returned to you alone and masked in the Channel. Google answers the PUT with the uploaded resource (a bundle's versionCode). An upload into an edit is live only after the edit is committed." };
    },
  },
};
