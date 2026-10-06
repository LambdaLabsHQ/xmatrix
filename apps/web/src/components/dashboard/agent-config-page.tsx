"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, HardDrive } from "lucide-react";
import {
  AGENT_PRESETS,
  agentPresetAvatarUrl,
  type SerializedSpace,
} from "@xmatrix/protocol";

import { useAndroidBackDismiss } from "@/components/dashboard/use-android-back";
import { GlassSelect } from "@/components/ui/glass-select";
import { Input } from "@/components/ui/input";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { Textarea } from "@/components/ui/textarea";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { cn } from "@/lib/utils";

import { DialogButton, DialogInset } from "./centered-dialog-shell";
import { IdentityAvatar } from "./identity-avatar";
import { SetupCardHeader, SetupCardShell } from "./space-setup-card-chrome";
import { AgentRoutingDeclarationEditor } from "./agent-routing-declaration-editor";
import { SpaceRegistrationPanel } from "./space-registration-panel";
import type { AgentConfigForm } from "./workspace-shell-agent-config-types";
import { agentPresetOrCustom, defaultAgentName } from "./workspace-shell-formatters";

/** The New agent page is open; `source` notes whether it came from local discovery. */
export type AgentConfigDialogState = {
  source?: "web" | "local-discovery";
};

/* Presets the desktop shell can npm-install; mirrors its native-owned allowlist
   in apps/desktop/src/agent-preset-install.ts, which stays the authority. */
const NATIVE_INSTALL_PRESETS = ["codex", "opencode", "pi", "copilot", "gemini", "qwen", "junie", "openclaw"];

/* One line naming everything the disclosure holds, so a closed Details is
   still an answer to "what else is there?" rather than a dead end. */
const DETAILS_SUMMARY = "Runtime command, arguments and file access";

/* Adding an agent is a page in the main column, on the same wood board and in
   the same narrow column as the Space setup screen (design owner,
   2026-09-14). The top half is the default path: pick a runtime and the name,
   machine and Space are already filled in. Everything else lives under
   Details, closed until asked for. The agent joins the Space as a
   registration of this machine's harness; its Space settings are changed
   from the Agents list. */
export function AgentConfigPage({
  state,
  form,
  spaces,
  token,
  busy,
  error,
  onFormChange,
  onCancel,
  onSubmit,
  onFindLocalAgents,
}: {
  state: AgentConfigDialogState | null;
  form: AgentConfigForm;
  spaces: SerializedSpace[];
  token?: string;
  busy: boolean;
  error: string | null;
  onFormChange: (patch: Partial<AgentConfigForm>) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** The desktop app lists the runtimes already installed on this machine, to add them from there. */
  onFindLocalAgents?: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState("");
  useAndroidBackDismiss(Boolean(state), onCancel, busy);

  if (!state) return null;

  const selectedPreset = agentPresetOrCustom(form.presetId);
  const runtimeLocked = form.presetId !== "custom";
  const desktop = getDesktopBridge();
  const presetChoices = AGENT_PRESETS.filter(
    (preset) => preset.id !== "custom" || form.presetId === "custom"
  );

  function applyPreset(presetId: string) {
    const preset = agentPresetOrCustom(presetId);
    const shouldUpdateName = !form.name.trim() || form.name.trim() === defaultAgentName(selectedPreset);
    onFormChange({
      presetId: preset.id,
      ...(shouldUpdateName ? { name: defaultAgentName(preset) } : {}),
      runtime: preset.runtime || form.runtime,
      argsText: preset.id === "custom" ? form.argsText : preset.defaultArgs.join("\n"),
    });
  }

  return (
    <section
      className="app-form-page app-message-surface app-message-surface-space-setup app-material-scroll-content relative flex min-w-0 flex-1 flex-col overflow-hidden"
      aria-labelledby="agent-config-title"
    >
      <div className="app-space-setup-canvas min-h-0 flex-1 overflow-y-auto">
        <SetupCardShell>
          <SetupCardHeader
            title="New agent"
            body="Already set up for this machine. Change the runtime below if you want a different one; Details holds everything else."
            titleId="agent-config-title"
          />

          {onFindLocalAgents && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
              <span>Already installed on this machine?</span>
              <DialogButton icon={HardDrive} disabled={busy} onClick={onFindLocalAgents}>
                Find agents on this machine
              </DialogButton>
            </div>
          )}

          {error && (
            <DialogInset tone="destructive" role="alert" className="mt-4 flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p className="font-semibold">{error}</p>
            </DialogInset>
          )}

          <LiquidGlassCard className="app-form-page-card app-setup-hero mt-5 rounded-[22px] p-5">
            <div className="flex items-center gap-3">
              <IdentityAvatar
                kind="agent"
                label={selectedPreset.displayName}
                imageUrl={agentPresetAvatarUrl(selectedPreset.id)}
                initials={selectedPreset.displayName.slice(0, 2)}
                size="md"
                className="app-space-agent-vendor-avatar shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-black leading-tight">{selectedPreset.displayName}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {selectedPreset.id === "custom"
                    ? "Any command you name under Details"
                    : `${selectedPreset.backend} · ${selectedPreset.runtime}`}
                </p>
              </div>
            </div>

            {/* `items-start`: a field whose list is open must grow on its own
                rather than stretching the field beside it, which would leave
                that input floating away from its own label. */}
            <div className="app-form-page-divider mt-4 grid items-start gap-4 border-t pt-4 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <Field label="Name">
                <Input
                  value={form.name}
                  onChange={(event) => onFormChange({ name: event.target.value })}
                  className="h-9"
                  placeholder="codex"
                />
              </Field>
              <Field label="Space">
                <GlassSelect
                  value={form.spaceId}
                  placeholder="Choose a Space"
                  options={spaces.map((space) => ({ value: space.id, label: space.name }))}
                  onChange={(spaceId) => onFormChange({ spaceId })}
                />
              </Field>
            </div>

            <DialogInset className="mt-3 flex items-center gap-2 text-xs">
              <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">Runs on</span>
              <span className="min-w-0 truncate font-bold">this machine</span>
            </DialogInset>
          </LiquidGlassCard>
          <div className="mt-4"><AgentRoutingDeclarationEditor value={form.routing}
            disabled={false}
            onChange={routing => onFormChange({ routing })} /></div>
          {desktop?.installAgentPreset && NATIVE_INSTALL_PRESETS.includes(form.presetId) && <div className="mt-3 text-sm">
            <button type="button" disabled={installing || busy} className="underline" onClick={async () => {
              setInstalling(true); setInstallMessage("");
              try {
                const result = await desktop.installAgentPreset!(form.presetId);
                setInstallMessage(result.message);
              } catch { setInstallMessage("Installation failed. Try again from this machine."); }
              finally { setInstalling(false); }
            }}>{installing ? "Installing…" : `Install ${selectedPreset.displayName} on this machine`}</button>
            {installMessage && <p role="status" className="mt-1 text-xs">{installMessage}</p>}
          </div>}

          <section className="mt-5" aria-labelledby="agent-config-runtime-label">
            <h3 id="agent-config-runtime-label" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Runtime
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Runtime">
              {presetChoices.map((preset) => {
                const selected = preset.id === form.presetId;
                return (
                  <LiquidGlassCard
                    key={preset.id}
                    as="label"
                    data-selected={selected ? "true" : "false"}
                    className="app-space-agent-candidate app-runtime-choice app-runtime-tile cursor-pointer rounded-[18px] p-2.5"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <input
                        type="radio"
                        name="agent-config-preset"
                        value={preset.id}
                        checked={selected}
                        onChange={() => applyPreset(preset.id)}
                        className="sr-only"
                      />
                      <IdentityAvatar
                        kind="agent"
                        label={preset.displayName}
                        imageUrl={agentPresetAvatarUrl(preset.id)}
                        initials={preset.displayName.slice(0, 2)}
                        size="sm"
                        className="app-space-agent-vendor-avatar shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-bold sm:text-sm">{preset.displayName}</span>
                      {selected && <Check className="size-4 shrink-0" />}
                    </span>
                  </LiquidGlassCard>
                );
              })}
            </div>
          </section>

          <LiquidGlassCard id="agent-config-details" className="app-form-page-card mt-5 overflow-hidden rounded-[22px]">
            <button
              type="button"
              aria-expanded={detailsOpen}
              aria-controls="agent-config-details-body"
              onClick={() => setDetailsOpen((open) => !open)}
              className="flex w-full items-center gap-3 px-5 py-4 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-black leading-tight">Details</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{DETAILS_SUMMARY}</span>
              </span>
              <ChevronDown className={cn("size-4 shrink-0 transition-transform", detailsOpen && "rotate-180")} />
            </button>
            {detailsOpen && (
              <div id="agent-config-details-body" className="app-form-page-divider border-t px-5 pb-5 pt-4">
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <Field label="Runtime">
                    <Input
                      value={form.runtime}
                      disabled={runtimeLocked}
                      onChange={(event) => onFormChange({ runtime: event.target.value })}
                      className="h-9"
                      placeholder="codex"
                    />
                  </Field>
                  <Field label="Backend">
                    <Input value={selectedPreset.backend} disabled className="h-9 font-mono" />
                  </Field>
                  <Field label="Arguments" hint="one per line" className="sm:col-span-2">
                    <Textarea
                      value={form.argsText}
                      onChange={(event) => onFormChange({ argsText: event.target.value })}
                      className="min-h-20 resize-y font-mono text-sm"
                      placeholder="--model gpt-5"
                    />
                  </Field>
                </div>

              </div>
            )}
          </LiquidGlassCard>

          <div className="app-form-page-divider mt-6 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-xs text-muted-foreground">
              Adds this machine&apos;s {selectedPreset.displayName} to the Space, with your directories on this machine.
            </p>
            <div className="flex shrink-0 gap-2">
              <DialogButton disabled={busy} onClick={onCancel}>
                Cancel
              </DialogButton>
              <DialogButton tone="primary" busy={busy} icon={Check} disabled={busy || !form.name.trim() || !form.spaceId} onClick={onSubmit}>
                Add agent
              </DialogButton>
            </div>
          </div>
        </SetupCardShell>
        {token && form.spaceId ? <SpaceRegistrationPanel spaceId={form.spaceId} token={token} /> : null}
      </div>
    </section>
  );
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="flex items-baseline gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
      {children}
      {hint && <span className="font-normal normal-case tracking-normal">{hint}</span>}
    </span>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("app-dialog-field grid gap-1.5", className)}>
      <FieldLabel hint={hint}>{label}</FieldLabel>
      {children}
    </label>
  );
}
