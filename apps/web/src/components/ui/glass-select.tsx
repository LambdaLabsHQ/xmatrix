"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export type GlassSelectOption = {
  value: string;
  label: string;
  /** Secondary text on the same row (status, version, path). */
  hint?: string;
  disabled?: boolean;
};

/* This app has no native `<select>` and no floating dropdown (design owner,
   2026-09-17: "不允许使用系统下拉框", then "我都说了不要悬浮窗"). A native
   control paints the platform's own popup — the OS list, on the OS background,
   with padding nothing here can reach — and a portalled panel is only that
   popup rebuilt in our own materials: still a window hovering over the board.

   So this opens in place. The trigger wears the same glass rule as every other
   control (materials.css lists it beside input/textarea), and the list unrolls
   underneath it in the document flow, pushing the rest of the card down — the
   same motion the Details disclosure makes. Nothing is portalled and nothing is
   positioned, so the `overflow-hidden` cards this sits inside have nothing to
   clip. */

export function GlassSelect({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  disabled = false,
  autoFocus = false,
  id,
  className,
  listClassName,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string;
  options: GlassSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Mirrors the native control's `autoFocus`, so this is a drop-in for one. */
  autoFocus?: boolean;
  id?: string;
  className?: string;
  listClassName?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const generatedId = useId();
  const listId = `${id ?? generatedId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex);
  const selected = selectedIndex < 0 ? undefined : options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function openList(index: number) {
    if (disabled || options.length === 0) return;
    setActiveIndex(clampIndex(index, options.length));
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function step(from: number, direction: 1 | -1) {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const next = clampIndex(from + direction * offset, options.length);
      if (!options[next]?.disabled) return next;
    }
    return from;
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openList(selectedIndex < 0 ? 0 : selectedIndex);
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((current) => step(current, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => step(current, -1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(step(-1, 1));
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(step(options.length, -1));
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <div ref={rootRef} className="app-glass-select min-w-0">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        autoFocus={autoFocus}
        /* A native `<select>` exposed its current value; this has to as well,
           or the only way to read the selection is the label text — which is
           display copy and changes for reasons the selection did not. */
        data-value={value}
        onClick={() => (open ? setOpen(false) : openList(selectedIndex < 0 ? 0 : selectedIndex))}
        onKeyDown={handleKeyDown}
        className={cn(
          "app-glass-select-trigger flex h-9 w-full items-center gap-2 border border-border bg-background px-3 text-left text-sm outline-none disabled:opacity-60",
          className
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}>
          {selected?.label ?? placeholder}
        </span>
        {selected?.hint && (
          <span className="shrink-0 truncate text-xs text-muted-foreground">{selected.hint}</span>
        )}
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          /* `app-dialog-inset` is the glass block every fact and option on
             these surfaces already wears, so the open list is built from the
             page's own parts rather than from a panel of its own. */
          className={cn(
            "app-dialog-inset app-glass-select-list mt-2 max-h-64 overflow-y-auto p-1",
            listClassName
          )}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-active={index === activeIndex ? "true" : "false"}
              data-disabled={option.disabled ? "true" : "false"}
              onPointerEnter={() => !option.disabled && setActiveIndex(index)}
              /* Keep the trigger focused so the keyboard model stays on one
                 element; without this the click steals focus first. */
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(index)}
              className="app-glass-select-option flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-semibold">{option.label}</span>
              {option.hint && (
                <span className="shrink-0 truncate text-xs text-muted-foreground">{option.hint}</span>
              )}
              <Check className={cn("size-4 shrink-0", option.value !== value && "opacity-0")} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function clampIndex(index: number, length: number) {
  if (length === 0) return 0;
  return ((index % length) + length) % length;
}
