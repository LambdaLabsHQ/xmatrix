import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HUB_ENVIRONMENT, type HubEnvironmentScope } from "../src/hub-environment";

export const HUB_ENVIRONMENT_DOC = fileURLToPath(
  new URL("../../../docs/operations/hub-environment.md", import.meta.url),
);

const SECTIONS: { scope: HubEnvironmentScope; title: string; intro: string }[] = [
  { scope: "required", title: "Required", intro: "Every deployment provides these. Secrets go in with `wrangler secret put` (or `--secrets-file`); bindings come from the rendered config." },
  { scope: "deployment", title: "Deployment profile", intro: "Set under `hub.vars` (or derived from the origins) in `deploy/profiles/<name>.json`; see `deploy/README.md`." },
  { scope: "feature", title: "Optional features", intro: "Leave unset to keep the feature off." },
  { scope: "tuning", title: "Tuning", intro: "Optional overrides of code defaults." },
  { scope: "product", title: "Product configuration", intro: "Declared by the committed `packages/hub/wrangler.toml`. Deployments do not change these." },
  { scope: "operator", title: "Official deployment operations", intro: "Used only by the operators of the hosted xMatrix deployment. Leave unset." },
  { scope: "test", title: "Local and test deployments", intro: "Never set these in production." },
];

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

export function renderHubEnvironmentDoc(): string {
  const entries = Object.entries(HUB_ENVIRONMENT);
  const lines = [
    "# Hub environment",
    "",
    "<!-- Generated from packages/hub/src/hub-environment.ts by `pnpm --filter @xmatrix/hub env:doc`. Do not edit by hand. -->",
    "",
    "Every binding, secret and variable the Hub Worker reads. A Hub test fails when this file and the catalog disagree.",
  ];
  for (const section of SECTIONS) {
    const rows = entries.filter(([, entry]) => entry.scope === section.scope)
      .sort(([a], [b]) => a.localeCompare(b));
    if (rows.length === 0) continue;
    lines.push("", `## ${section.title}`, "", section.intro, "", "| Name | Kind | What it does |", "| --- | --- | --- |");
    for (const [name, entry] of rows) lines.push(`| \`${name}\` | ${entry.kind} | ${cell(entry.summary)} |`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(HUB_ENVIRONMENT_DOC, renderHubEnvironmentDoc());
  process.stdout.write(`wrote ${HUB_ENVIRONMENT_DOC}\n`);
}
