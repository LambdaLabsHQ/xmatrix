"use client";

import type { AgentRoutingDeclaration } from "@xmatrix/protocol";
import { useEffect, useState } from "react";

import { GlassSelect } from "@/components/ui/glass-select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const empty: AgentRoutingDeclaration = { schemaVersion: 1, enabled: true, models: [], description: "",
  availability: "unknown", capabilities: [] };

export function AgentRoutingDeclarationEditor({ value, disabled, onChange }: {
  value?: AgentRoutingDeclaration; disabled: boolean; onChange: (value: AgentRoutingDeclaration) => void;
}) {
  const declaration = value ?? empty;
  const [modelText, setModelText] = useState(declaration.models.join("\n"));
  useEffect(() => {
    if (modelText.split("\n").map(item => item.trim()).filter(Boolean).join("\n") !== declaration.models.join("\n")) {
      setModelText(declaration.models.join("\n"));
    }
  }, [declaration.models, modelText]);
  const update = (patch: Partial<AgentRoutingDeclaration>) => onChange({ ...declaration, ...patch });
  return <fieldset disabled={disabled} className="space-y-3 rounded border border-border p-4">
    <legend className="px-1 text-sm font-bold">Automatic routing</legend>
    {/* Whether the agent takes work is its owner's Disable/Enable on the Agents page. */}
    <>
      <p className="text-xs text-muted-foreground">Describe this environment’s capabilities and limits. Machine reachability, resource usage and startup timing are measured separately.</p>
      <label className="block text-sm">Supported model IDs, one per line<Textarea className="mt-1" rows={2}
        value={modelText} onChange={event => { setModelText(event.target.value);
          const models = event.target.value.split("\n").map(item => item.trim()).filter(Boolean);
          update({ models, modelAliases: Object.fromEntries(Object.entries(declaration.modelAliases ?? {}).filter(([key]) => models.includes(key))) }); }} /></label>
      {declaration.models.map(model => <label key={model} className="block text-sm">Runtime model ID for {model} (optional)
        <Input className="mt-1 h-9" value={declaration.modelAliases && Object.hasOwn(declaration.modelAliases, model) ? declaration.modelAliases[model] : ""} placeholder={model} maxLength={160}
          onChange={event => {
            const aliases = { ...declaration.modelAliases };
            if (event.target.value.trim()) aliases[model] = event.target.value;
            else delete aliases[model];
            update({ modelAliases: aliases });
          }} /></label>)}
      <label className="block text-sm">Suitable work and limitations<Textarea className="mt-1" maxLength={1000} rows={3}
        value={declaration.description} onChange={event => update({ description: event.target.value })} /></label>
      <label className="block text-sm">Availability<GlassSelect aria-label="Availability" value={declaration.availability}
        onChange={value => update({ availability: value as AgentRoutingDeclaration["availability"] })}
        options={[{ value: "unknown", label: "Not specified" }, { value: "interactive", label: "While I am here" },
          { value: "unattended", label: "Can run unattended" }]} disabled={disabled} /></label>
      <label className="block text-sm">Registered working directory for work without a repository<Input className="mt-1 h-9"
        value={declaration.defaultWorkspace ?? ""} onChange={event => update({ defaultWorkspace: event.target.value || undefined })} /></label>
      <label className="block text-sm">Available until (UTC, optional)<Input className="mt-1 h-9" placeholder="2026-09-20T08:00:00Z"
        value={declaration.availableUntil ?? ""} onChange={event => update({ availableUntil: event.target.value || undefined })} /></label>
      <p className="text-sm font-semibold">Environment capabilities</p>
      {declaration.capabilities.map((capability, index) => <div key={index} className="space-y-2 border-t border-border pt-2">
        <Input aria-label={`Capability ${index + 1} key`} className="h-9" placeholder="browser:billing" value={capability.key}
          onChange={event => update({ capabilities: declaration.capabilities.map((item, at) => at === index ? { ...item, key: event.target.value } : item) })} />
        <Input aria-label={`Capability ${index + 1} description`} className="h-9" placeholder="What this environment can access; no credentials" value={capability.description}
          onChange={event => update({ capabilities: declaration.capabilities.map((item, at) => at === index ? { ...item, description: event.target.value } : item) })} />
        <Input aria-label={`Capability ${index + 1} expiry in UTC`} className="h-9" placeholder="Expires at (UTC)" value={capability.expiresAt}
          onChange={event => update({ capabilities: declaration.capabilities.map((item, at) => at === index ? { ...item, expiresAt: event.target.value } : item) })} />
        <button type="button" className="text-xs underline" onClick={() => update({ capabilities: declaration.capabilities.filter((_, at) => at !== index) })}>Remove capability</button>
      </div>)}
      <button type="button" disabled={declaration.capabilities.length >= 32} className="text-sm underline"
        onClick={() => update({ capabilities: [...declaration.capabilities, { key: "", description: "", expiresAt: "" }] })}>Add capability</button>
    </>
  </fieldset>;
}
