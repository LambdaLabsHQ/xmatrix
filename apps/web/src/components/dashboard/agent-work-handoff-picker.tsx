"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, SlidersHorizontal, X } from "lucide-react";
import { launchHarnessParameters, type AgentRegistrationSummary, type AutoLaunchTags } from "@xmatrix/protocol";
import {
  compatibleHandoffSuccessors,
  handoffPickerHasOptions,
  handoffPickerParameters,
  handoffTagChips,
  toggleHandoffPickerTag,
} from "./handoff-picker-options";

const PICKER_CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-foreground/12 bg-transparent px-2 py-0.5 text-[11px] font-semibold leading-tight text-foreground transition-colors cursor-pointer hover:not-disabled:bg-foreground/7 data-[selected]:border-primary/45 data-[selected]:bg-primary/14 data-[selected]:text-primary disabled:opacity-45 disabled:cursor-not-allowed";

function PickerOptionGroup({
  label,
  options,
  selectedValue,
  onToggle,
}: {
  label: string;
  options: readonly { value: string; label: string; unavailable?: string }[];
  selectedValue: string | undefined;
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const active = selectedValue === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={Boolean(option.unavailable)}
              aria-pressed={active}
              data-selected={active || undefined}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggle(option.value);
              }}
              className={PICKER_CHIP_CLASS}
            >
              <span>{option.label}</span>
              {option.unavailable && <span className="app-agent-work-picker-hint">{option.unavailable}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AgentWorkHandoffPicker({
  label,
  instanceLabel,
  disabled,
  armedAction,
  onClearArmed,
  onPressArmed,
  registrations,
  capabilityHarnesses,
  onBack,
  onSelect,
  onLayoutChange,
}: {
  label: string;
  instanceLabel?: string;
  disabled: boolean;
  armedAction: string | null;
  onClearArmed: () => void;
  onPressArmed: (action: string, send: () => void) => void;
  registrations: readonly AgentRegistrationSummary[];
  capabilityHarnesses: readonly string[];
  onBack: () => void;
  onSelect: (successor: string, tags: AutoLaunchTags) => void;
  onLayoutChange?: () => void;
}) {
  const [selectedTags, setSelectedTags] = useState<AutoLaunchTags>({});
  const [optionsOpen, setOptionsOpen] = useState(false);

  const hasOptions = useMemo(() => handoffPickerHasOptions(registrations), [registrations]);
  const parameterOptions = useMemo(
    () => handoffPickerParameters(registrations, selectedTags),
    [registrations, selectedTags],
  );
  const successors = useMemo(
    () => compatibleHandoffSuccessors(registrations, capabilityHarnesses, selectedTags),
    [registrations, capabilityHarnesses, selectedTags],
  );
  const tagChips = useMemo(() => handoffTagChips(selectedTags), [selectedTags]);
  const selectedParameters = useMemo(() => launchHarnessParameters(selectedTags), [selectedTags]);

  useEffect(() => {
    onLayoutChange?.();
  }, [optionsOpen, selectedTags, onLayoutChange]);

  function toggleTag(
    change: { field: "machine" | "model" | "effort"; value: string } | { field: "parameter"; parameterId: string; value: string },
  ) {
    onClearArmed();
    setSelectedTags((current) => toggleHandoffPickerTag(current, registrations, change));
  }

  function removeTagChip(chip: ReturnType<typeof handoffTagChips>[number]) {
    if (chip.field === "parameter" && chip.parameterId) {
      toggleTag({ field: "parameter", parameterId: chip.parameterId, value: selectedParameters[chip.parameterId] ?? "" });
    } else if (chip.field !== "parameter") {
      toggleTag({ field: chip.field, value: selectedTags[chip.field] ?? "" });
    }
  }

  if (optionsOpen) {
    return (
      <>
        <div className="app-agent-work-picker-header">
          <button
            type="button"
            aria-label="Back to handoff targets"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOptionsOpen(false);
            }}
            className="app-agent-work-action"
            data-action="back"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
          </button>
          <span className="app-agent-work-picker-label">Handoff parameters</span>
          {tagChips.length > 0 && (
            <button
              type="button"
              aria-label="Clear handoff parameters"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClearArmed();
                setSelectedTags({});
              }}
              className="app-agent-work-action ml-auto shrink-0"
              data-action="handoff-clear-options"
            >
              <span>Clear</span>
            </button>
          )}
        </div>
        <div className="app-agent-work-picker-list max-w-[17rem] gap-2 p-1" role="group" aria-label="Handoff parameters">
          <PickerOptionGroup
            label="Machine"
            options={parameterOptions.machines}
            selectedValue={selectedTags.machine}
            onToggle={(value) => toggleTag({ field: "machine", value })}
          />
          <PickerOptionGroup
            label="Model"
            options={parameterOptions.models}
            selectedValue={selectedTags.model}
            onToggle={(value) => toggleTag({ field: "model", value })}
          />
          <PickerOptionGroup
            label="Effort"
            options={parameterOptions.efforts}
            selectedValue={selectedTags.effort}
            onToggle={(value) => toggleTag({ field: "effort", value })}
          />
          {parameterOptions.parameters.map((group) => (
            <PickerOptionGroup
              key={group.id}
              label={group.label}
              options={group.options}
              selectedValue={selectedParameters[group.id]}
              onToggle={(value) => toggleTag({ field: "parameter", parameterId: group.id, value })}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="app-agent-work-picker-header">
        <button
          type="button"
          aria-label="Back to controls"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onBack();
          }}
          className="app-agent-work-action"
          data-action="back"
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
        </button>
        <span className="app-agent-work-picker-label">Hand off {label} to</span>
        {hasOptions && (
          <button
            type="button"
            aria-label="Handoff parameters"
            title="Choose machine, model or effort"
            data-active={tagChips.length > 0 || undefined}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClearArmed();
              setOptionsOpen(true);
            }}
            className="app-agent-work-action ml-auto shrink-0 data-[active]:text-primary"
            data-action="handoff-options"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            {tagChips.length > 0 && <span className="text-[10px] font-bold leading-none">{tagChips.length}</span>}
          </button>
        )}
      </div>
      {tagChips.length > 0 && (
        <div className="flex max-w-[17rem] flex-wrap gap-1 px-1 pt-0.5 pb-1" role="group" aria-label="Selected handoff parameters">
          {tagChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              aria-label={`Remove ${chip.label}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                removeTagChip(chip);
              }}
              className={PICKER_CHIP_CLASS}
              data-selected="true"
            >
              <span>{chip.label}</span>
              <X className="size-2.5" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {/* One row per successor, so five or fifty stay one column;
          the list scrolls inside the toolbar past a few rows. */}
      <div className="app-agent-work-picker-list" role="group" aria-label={`Hand off ${instanceLabel} to`}>
        {successors.map((successor) => {
          const armed = armedAction === `handoff:${successor}`;
          const target = successor === "auto" ? "the best available agent" : `a new @${successor}`;
          return (
            <button
              key={successor}
              type="button"
              aria-label={`${armed ? "Confirm hand off" : "Hand off"} ${instanceLabel} to ${target}`}
              disabled={disabled}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onPressArmed(`handoff:${successor}`, () => {
                  onSelect(successor, selectedTags);
                });
              }}
              className="app-agent-work-action"
              data-action="handoff-successor"
              data-armed={armed || undefined}
            >
              <span>{armed ? "Confirm" : successor === "auto" ? "Auto" : `@${successor}`}</span>
              {successor === "auto" && !armed ? (
                <span className="app-agent-work-picker-hint">most headroom</span>
              ) : null}
            </button>
          );
        })}
        {successors.length === 0 && (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedTags({});
            }}
            className="app-agent-work-action"
          >
            <span>No matching agent · Clear</span>
          </button>
        )}
      </div>
    </>
  );
}
