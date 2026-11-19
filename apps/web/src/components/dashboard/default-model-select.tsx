"use client";

import { useState } from "react";

/** The menu entry that reveals a field for a model the menu does not list. */
const OTHER_MODEL = "__other_model__";

/** A registration's Default model as a menu: the harness default, the models
 * it offers, and "Other model…" for a name the menu does not list. Wrap it in
 * the field's label so both controls carry that name. */
export function DefaultModelSelect({ value, choices, disabled, className, inputClassName, onChange }: {
  value: string;
  choices: ReadonlyArray<{ model: string; description?: string }>;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  onChange: (model: string) => void;
}) {
  const [other, setOther] = useState(false);
  const selected = value.trim();
  const listed = !selected || choices.some(choice => choice.model === selected);
  const typing = other || !listed;
  return (
    <>
      <select
        value={typing ? OTHER_MODEL : selected}
        disabled={disabled}
        title={choices.find(choice => choice.model === selected)?.description || undefined}
        onChange={(event) => {
          const picked = event.target.value === OTHER_MODEL;
          setOther(picked);
          if (!picked) onChange(event.target.value);
        }}
        className={className}
      >
        <option value="">Harness default</option>
        {choices.map(choice => <option key={choice.model} value={choice.model}>{choice.model}</option>)}
        <option value={OTHER_MODEL}>Other model…</option>
      </select>
      {typing && (
        <input
          value={value}
          disabled={disabled}
          autoFocus={other}
          aria-label="Model name"
          placeholder="Model name"
          onChange={(event) => onChange(event.target.value)}
          className={inputClassName ?? className}
        />
      )}
    </>
  );
}
