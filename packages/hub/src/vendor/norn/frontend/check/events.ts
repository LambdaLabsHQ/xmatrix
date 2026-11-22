// Vendored from norn-lang/norn@3a8adebc52c4e8af22a0b40ddf7a2dfd7ca36f03; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Standard capability interface `Events` (CloudEvents 1.0.2) and static
 * connector manifest validation. Browser-safe.
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

export interface ConnectorManifest {
  app: string;
  events: readonly ConnectorEventSpec[];
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
  const resolved = resolve(payloadType);
  // `json` or unresolved variable escapes structural field checking.
  if (resolved.tag === "var" || (resolved.tag === "con" && resolved.name === "json")) return [];
  if (resolved.tag !== "con") return [];
  const info = table.lookupType(resolved.name);
  if (!info || info.kind !== "record") return [];
  const manifestFields = new Map(eventSpec.fields.map((f) => [f.name, f]));
  const manifestFieldNames = eventSpec.fields.map((f) => f.name);
  const diagnostics: CheckDiagnostic[] = [];
  for (const field of info.fields) {
    const spec = manifestFields.get(field.name);
    if (!spec) {
      const near = closest(field.name, manifestFieldNames);
      diagnostics.push({
        severity: "error",
        code: "manifest-field-mismatch",
        message: `event ${app}:${kindName} has no field ${field.name} in its connector manifest${near ? `; did you mean ${near}?` : ""}`,
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
        message: `event ${app}:${kindName} field ${field.name} has type ${spec.type} in its connector manifest, but program expects ${printType(resolve(field.type))}`,
        span,
        expected: spec.type,
        found: printType(resolve(field.type)),
      });
    }
  }
  return diagnostics;
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
