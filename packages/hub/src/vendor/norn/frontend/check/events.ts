// Vendored from norn-lang/norn@61e8a966a87029f980f965b95a41f63b3017dff5; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Standard capability interfaces `Events` (CloudEvents 1.0.2) and `Actions`,
 * and static connector manifest validation. Browser-safe.
 */
import type * as A from "../ast.js";
import { closest, type CheckDiagnostic } from "./diagnostics.js";
import type { TypeTable } from "./declarations.js";
import type { Form, ReportForm } from "./forms.js";
import { printType, resolve, type Type } from "./types.js";

/** Canonical `interfaces/events.norn` definition (embedded for browser safety). */
export const EVENTS_INTERFACE_SOURCE = `// Standard Capability Interface: Events (CloudEvents 1.0.2)
type kind<'a>
type envelope<'a> = {
  specversion: string,
  kind: string,
  source: string,
  id: string,
  occurredAt: option<time>,
  subject: option<string>,
  receivedAt: time,
  data: 'a,
}
external kind: (string, string) => kind<'a>
external events: (kind<'a>, ~source: string=?, ~subject: string=?) => stream<envelope<'a>>
`;

/** Canonical `interfaces/actions.norn` definition (embedded for browser safety). */
export const ACTIONS_INTERFACE_SOURCE = `// Standard Capability Interface: Actions
type action<'i, 'o>
type prepared<'o>
external action: (string, string) => action<'i, 'o>
external prepare: (action<'i, 'o>, 'i, ~by: 'd=?, ~about: 'c=?) => request<prepared<'o>>
external perform: (prepared<'o>, ~by: 'd=?) => request<'o>
`;

export interface ConnectorFieldSpec {
  name: string;
  type: "string" | "int" | "float" | "bool" | "time" | "json" | "list<string>" | "list<json>" | string;
  required?: boolean;
  doc?: string;
}

export interface ConnectorEventSpec {
  kind: string;
  doc?: string;
  fields: readonly ConnectorFieldSpec[];
}

/** An action a connected app performs for a program (`Actions.action(app, name)`): what it takes and what it answers. */
export interface ConnectorActionSpec {
  name: string;
  doc?: string;
  input: readonly ConnectorFieldSpec[];
  output: readonly ConnectorFieldSpec[];
}

export interface ConnectorManifest {
  app: string;
  events: readonly ConnectorEventSpec[];
  actions?: readonly ConnectorActionSpec[];
}

/**
 * Validates `Events.kind(app, kindName)` against supplied connector manifests:
 * checks that `(app, kindName)` exists and that any declared record fields
 * requested by `payloadType` exist in the manifest (while allowing `json` as
 * an explicit untyped escape hatch).
 */
export function validateEventKindAgainstManifests(
  app: string,
  kindName: string,
  payloadType: Type,
  span: A.Span,
  table: TypeTable,
  manifests: readonly ConnectorManifest[],
): CheckDiagnostic[] {
  if (manifests.length === 0) return [];
  const manifest = manifests.find((m) => m.app === app);
  if (!manifest) {
    const apps = manifests.map((m) => m.app);
    const near = closest(app, apps);
    return [{
      severity: "error",
      code: "unknown-event-kind",
      message: `unknown connector app ${JSON.stringify(app)} in Events.kind${near ? `; did you mean ${JSON.stringify(near)}?` : ""}`,
      span,
      candidates: apps,
    }];
  }
  const eventSpec = manifest.events.find((e) => e.kind === kindName);
  if (!eventSpec) {
    const kinds = manifest.events.map((e) => e.kind);
    const near = closest(kindName, kinds);
    return [{
      severity: "error",
      code: "unknown-event-kind",
      message: `connector ${JSON.stringify(app)} has no event kind ${JSON.stringify(kindName)}${near ? `; did you mean ${JSON.stringify(near)}?` : ""}`,
      span,
      candidates: kinds,
    }];
  }
  return recordAgainstFields(`event ${app}:${kindName}`, "its connector manifest", payloadType, eventSpec.fields, span, table, false);
}

/**
 * A record type a program wrote against the fields a manifest declares: every
 * field the program names must be declared, with the declared type. `json`,
 * or a type nothing has decided, is the explicit untyped escape. With
 * `complete`, the record must also give every field the manifest requires:
 * that is what a program hands to the host, where the rest is what it reads.
 */
function recordAgainstFields(
  what: string,
  where: string,
  type: Type,
  fields: readonly ConnectorFieldSpec[],
  span: A.Span,
  table: TypeTable,
  complete: boolean,
): CheckDiagnostic[] {
  const resolved = resolve(type);
  if (resolved.tag !== "con" || resolved.name === "json") return [];
  const info = table.lookupType(resolved.name);
  if (!info || info.kind !== "record") return [];
  const manifestFields = new Map(fields.map((f) => [f.name, f]));
  const manifestFieldNames = fields.map((f) => f.name);
  const diagnostics: CheckDiagnostic[] = [];
  for (const field of info.fields) {
    const spec = manifestFields.get(field.name);
    if (!spec) {
      const near = closest(field.name, manifestFieldNames);
      diagnostics.push({
        severity: "error",
        code: "manifest-field-mismatch",
        message: `${what} has no field ${field.name} in ${where}${near ? `; did you mean ${near}?` : ""}`,
        span,
        candidates: manifestFieldNames,
      });
      continue;
    }
    const actual = printType(resolve(field.type)).replace(/\s+/gu, "");
    const expected = spec.type.replace(/\s+/gu, "");
    const expectedOptional = spec.required === false ? `option<${expected}>` : null;
    if (actual !== "json" && expected !== "json" && actual !== expected && actual !== expectedOptional) {
      diagnostics.push({
        severity: "error",
        code: "manifest-field-mismatch",
        message: `${what} field ${field.name} has type ${spec.type} in ${where}, but program expects ${printType(resolve(field.type))}`,
        span,
        expected: spec.type,
        found: printType(resolve(field.type)),
      });
    }
  }
  if (complete) {
    const given = new Set(info.fields.map((field) => field.name));
    for (const spec of fields) {
      if (spec.required === false || given.has(spec.name)) continue;
      diagnostics.push({
        severity: "error",
        code: "manifest-field-mismatch",
        message: `${what} requires the field ${spec.name}: ${spec.type} in ${where}`,
        span,
        expected: spec.type,
      });
    }
  }
  return diagnostics;
}

/**
 * Validates `Actions.action(app, name)` against supplied connector manifests:
 * the app declares that action, the input type gives every field the action
 * requires and none it does not declare, and the output type reads only
 * declared fields. `json` on either side is the untyped escape.
 */
export function validateActionAgainstManifests(
  app: string,
  name: string,
  inputType: Type,
  outputType: Type,
  span: A.Span,
  table: TypeTable,
  manifests: readonly ConnectorManifest[],
): CheckDiagnostic[] {
  if (manifests.length === 0) return [];
  const manifest = manifests.find((m) => m.app === app);
  if (!manifest) {
    const apps = manifests.map((m) => m.app);
    const near = closest(app, apps);
    return [{
      severity: "error",
      code: "unknown-action",
      message: `unknown connector app ${JSON.stringify(app)} in Actions.action${near ? `; did you mean ${JSON.stringify(near)}?` : ""}`,
      span,
      candidates: apps,
    }];
  }
  const spec = (manifest.actions ?? []).find((action) => action.name === name);
  if (!spec) {
    const names = (manifest.actions ?? []).map((action) => action.name);
    const near = closest(name, names);
    return [{
      severity: "error",
      code: "unknown-action",
      message: `connector ${JSON.stringify(app)} has no action ${JSON.stringify(name)}${near ? `; did you mean ${JSON.stringify(near)}?` : ""}`,
      span,
      candidates: names,
    }];
  }
  return [
    ...recordAgainstFields(`the input of action ${app}:${name}`, "its connector manifest", inputType, spec.input, span, table, true),
    ...recordAgainstFields(`the answer of action ${app}:${name}`, "its connector manifest", outputType, spec.output, span, table, false),
  ];
}

function parseManifestFieldForm(typeExpr: string): Form {
  const trimmed = typeExpr.trim();
  const listMatch = /^list<(.+)>$/u.exec(trimmed);
  if (listMatch) return { kind: "list", element: parseManifestFieldForm(listMatch[1]!) };
  if (trimmed === "json") return { kind: "any" };
  if (["string", "int", "float", "bool", "time", "duration", "unit"].includes(trimmed)) {
    return { kind: "base", name: trimmed };
  }
  return { kind: "any" };
}

/** Builds a runtime `ReportForm` from a `ConnectorEventSpec` for `deliverEvent(..., { form })` validation. */
export function manifestEventForm(spec: ConnectorEventSpec): ReportForm {
  const requiredFields = spec.fields.filter((f) => f.required !== false);
  const typeName = `event:${spec.kind}`;
  return {
    text: `{${requiredFields.map((f) => `${f.name}: ${f.type}`).join(", ")}}`,
    form: { kind: "named", name: typeName },
    definitions: {
      [typeName]: {
        kind: "record",
        fields: requiredFields.map((f) => ({ name: f.name, form: parseManifestFieldForm(f.type) })),
      },
    },
  };
}

/**
 * Builds the runtime `ReportForm` of what an action answers, from its
 * `ConnectorActionSpec`: a host checks its own answer against it before it
 * settles the `Actions.perform` request.
 */
export function manifestActionForm(app: string, spec: ConnectorActionSpec): ReportForm {
  const requiredFields = spec.output.filter((f) => f.required !== false);
  const typeName = `action:${app}:${spec.name}`;
  return {
    text: `{${requiredFields.map((f) => `${f.name}: ${f.type}`).join(", ")}}`,
    form: { kind: "named", name: typeName },
    definitions: {
      [typeName]: {
        kind: "record",
        fields: requiredFields.map((f) => ({ name: f.name, form: parseManifestFieldForm(f.type) })),
      },
    },
  };
}
