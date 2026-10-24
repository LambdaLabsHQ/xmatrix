"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { baseKeymap, splitBlock } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import type { DraftSummonIntent, FaceOf } from "@xmatrix/protocol";
import { composerHintParts } from "./composer-hints";
import {
  composerDocFromText,
  composerOffsetOf,
  composerPosOf,
  composerSchema,
  composerTextOf,
  composerTextOfFragment,
} from "./composer-editor-text";
import { MentionChipFace } from "./mention-chip-face";
import { composerMentionSpans, type ComposerMentionSpan, type MentionReadIndex } from "./mention-read-state";

/**
 * The composer's text field, as the rest of the composer reads it: the draft
 * text and a selection in draft offsets. It stands where the textarea stood,
 * so completion, paste and focus code keep working in text terms.
 */
export interface ComposerField {
  readonly element: HTMLElement;
  /** Setting the value replaces the text without reporting a change, as assigning a textarea's does. */
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly disabled: boolean;
  setSelectionRange(start: number, end: number): void;
  focus(options?: FocusOptions): void;
  blur(): void;
}

/** The parts of a key press the composer's handlers read; a React keyboard event has them too. */
export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  nativeEvent: KeyboardEvent;
  defaultPrevented: boolean;
  preventDefault(): void;
}

export interface ComposerEditorProps {
  value: string;
  fieldRef: RefObject<ComposerField | null>;
  ariaLabel: string;
  className: string;
  disabled?: boolean;
  /** Faint words shown where the text would start while the draft is empty. */
  hint?: string;
  /** The Channel's member index; the same one the timeline resolves chips with. */
  mentionIndex: MentionReadIndex | null;
  currentUserIdentityId?: string;
  /** Picked channel and page references, drawn like the chips they send as. */
  references?: ReadonlyArray<{ start: number; end: number; text: string }>;
  /** Jev's reading of each summon while the author types, matched to its chip by text. */
  summonReadings?: ReadonlyArray<DraftSummonIntent>;
  summonReadingPending?: boolean;
  onChange: (value: string, field: ComposerField) => void;
  /** The caret moved without the text changing. */
  onSelect?: (field: ComposerField) => void;
  onKeyDown?: (event: ComposerKeyEvent, field: ComposerField) => void;
  onBeforeInput?: (event: InputEvent, field: ComposerField) => void;
  onCompositionStart?: (field: ComposerField) => void;
  onFocus?: (field: ComposerField) => void;
  onBlur?: (field: ComposerField) => void;
  onTouchStart?: (field: ComposerField) => void;
  onPointerDown?: (event: PointerEvent, field: ComposerField) => void;
  onPointerUp?: (event: PointerEvent, field: ComposerField) => void;
  onClick?: (field: ComposerField) => void;
  onPaste?: (event: ClipboardEvent, field: ComposerField) => void;
  /** Overlays positioned over the text (summon options). */
  children?: ReactNode;
}

const NO_SPANS: readonly ComposerMentionSpan[] = [];
const UNDO_GROUP_MS = 600;

/**
 * The composer's editor. The draft text is the source: each line is a
 * paragraph, and the mentions in it are drawn with the sent message's own chip
 * (face, then `@name`, in one pill) as decorations over text that stays
 * editable. Nothing but text is ever stored, so a draft sends, saves and
 * completes exactly as it did in the textarea.
 */
export function ComposerEditor(props: ComposerEditorProps) {
  const propsRef = useRef(props);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [portals] = useState(() => new PortalRegistry());
  const portalEntries = useSyncExternalStore(portals.subscribe, portals.snapshot, portals.snapshot);

  // First of the effects, so the view and the ones below read this render's props.
  useLayoutEffect(() => {
    propsRef.current = props;
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const history = new TextHistory();
    let reporting = true;
    const fieldRef = propsRef.current.fieldRef;
    const decorationsFor = spanDecorations(propsRef, portals);
    const view: EditorView = new EditorView(host, {
      state: EditorState.create({
        schema: composerSchema,
        doc: composerDocFromText(propsRef.current.value),
        plugins: [
          keymap({
            "Mod-z": () => restore(history.undo(snapshot())),
            "Mod-Shift-z": () => restore(history.redo(snapshot())),
            "Mod-y": () => restore(history.redo(snapshot())),
            "Shift-Enter": splitBlock,
          }),
          keymap(baseKeymap),
        ],
      }),
      attributes: () => attributesOf(propsRef.current),
      editable: () => !propsRef.current.disabled,
      decorations: (state) => decorationsFor(state),
      clipboardTextSerializer: (slice) => composerTextOfFragment(slice.content),
      handleKeyDown: (_view, event) => {
        const key = keyEvent(event);
        propsRef.current.onKeyDown?.(key, field);
        return key.defaultPrevented;
      },
      handlePaste: (_view, event) => {
        propsRef.current.onPaste?.(event, field);
        if (event.defaultPrevented) return true;
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;
        replaceSelectionWithText(view, text);
        return true;
      },
      // Typed beside a chip, a space comes out of the browser as a no-break
      // space (it keeps the space from collapsing). A draft is text as typed.
      handleTextInput: (_view, from, to, text) => {
        if (!text.includes("\u00A0")) return false;
        view.dispatch(view.state.tr.insertText(text.replaceAll("\u00A0", " "), from, to));
        return true;
      },
      // Dropped files are attachments, taken by the window's drop sink as the
      // event bubbles on; the editor must not also insert whatever text they carry.
      handleDrop: (_view, event) => Boolean((event as DragEvent).dataTransfer?.types.includes("Files")),
      handleDOMEvents: {
        beforeinput: (_view, event) => {
          const input = event as InputEvent;
          if (input.inputType === "historyUndo" || input.inputType === "historyRedo") {
            event.preventDefault();
            restore(input.inputType === "historyUndo" ? history.undo(snapshot()) : history.redo(snapshot()));
            return true;
          }
          propsRef.current.onBeforeInput?.(input, field);
          return false;
        },
        compositionstart: () => {
          propsRef.current.onCompositionStart?.(field);
          return false;
        },
        focus: () => {
          propsRef.current.onFocus?.(field);
          return false;
        },
        blur: () => {
          propsRef.current.onBlur?.(field);
          return false;
        },
        touchstart: () => {
          propsRef.current.onTouchStart?.(field);
          return false;
        },
        pointerdown: (_view, event) => {
          propsRef.current.onPointerDown?.(event as PointerEvent, field);
          return false;
        },
        pointerup: (_view, event) => {
          propsRef.current.onPointerUp?.(event as PointerEvent, field);
          return false;
        },
        click: () => {
          propsRef.current.onClick?.(field);
          return false;
        },
        keyup: () => {
          propsRef.current.onSelect?.(field);
          return false;
        },
      },
      dispatchTransaction(transaction: Transaction) {
        const before = view.state;
        view.updateState(before.apply(transaction));
        if (transaction.docChanged) {
          if (reporting && !transaction.getMeta(EXTERNAL)) {
            history.record(snapshotOf(before));
            propsRef.current.onChange(composerTextOf(view.state.doc), field);
          }
        } else if (transaction.selectionSet && reporting) {
          propsRef.current.onSelect?.(field);
        }
      },
    });
    viewRef.current = view;

    const snapshot = () => snapshotOf(view.state);
    function restore(entry: TextSnapshot | undefined): boolean {
      if (!entry) return true;
      setText(view, entry.text, entry.start, entry.end, true);
      propsRef.current.onChange(entry.text, field);
      return true;
    }

    const field: ComposerField = {
      element: view.dom,
      get value() {
        return composerTextOf(view.state.doc);
      },
      set value(text: string) {
        reporting = false;
        try {
          setText(view, text, text.length, text.length, true);
        } finally {
          reporting = true;
        }
      },
      get selectionStart() {
        return composerOffsetOf(view.state.doc, view.state.selection.from);
      },
      get selectionEnd() {
        return composerOffsetOf(view.state.doc, view.state.selection.to);
      },
      get disabled() {
        return Boolean(propsRef.current.disabled);
      },
      setSelectionRange(start: number, end: number) {
        const doc = view.state.doc;
        const selection = TextSelection.create(doc, composerPosOf(doc, start), composerPosOf(doc, end));
        if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection).setMeta(EXTERNAL, true));
      },
      focus(options?: FocusOptions) {
        view.dom.focus(options);
      },
      blur() {
        view.dom.blur();
      },
    };
    fieldRef.current = field;
    // The field on its element too, where tests and devtools read the draft as text.
    (view.dom as FieldElement).composerField = field;
    const stopCaret = softCaret(view, host);
    return () => {
      stopCaret();
      if (fieldRef.current === field) fieldRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
    // The view lives as long as the component; props reach it through propsRef.
  }, [portals]);

  // A draft written from outside (a channel's restored draft, a send that
  // cleared it, a completion pick) replaces the text and puts the caret at its
  // end, as setting a textarea's value does; a completion then places it.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || composerTextOf(view.state.doc) === props.value) return;
    setText(view, props.value, props.value.length, props.value.length, true);
  }, [props.value]);

  // The hint is drawn over the field where the text would start, outside the
  // editable content: inside it, a select-all and type took its words along.
  const showHint = Boolean(props.hint) && !props.value.replaceAll("\u200B", "");
  const hintRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const view = viewRef.current;
    const hint = hintRef.current;
    if (!showHint || !view || !hint) return;
    const input = view.dom;
    const place = () => {
      const style = getComputedStyle(input);
      for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"] as const) hint.style[key] = style[key];
      hint.style.left = `${input.offsetLeft + input.clientLeft + (parseFloat(style.paddingLeft) || 0)}px`;
      hint.style.top = `${input.offsetTop + input.clientTop + (parseFloat(style.paddingTop) || 0)}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(input);
    document.fonts?.addEventListener("loadingdone", place);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", place);
    };
  }, [showHint]);

  // Anything the chips are drawn from: redraw them.
  useLayoutEffect(() => {
    viewRef.current?.setProps({});
  }, [props.disabled, props.ariaLabel, props.className, props.mentionIndex, props.currentUserIdentityId,
    props.references, props.summonReadings, props.summonReadingPending]);

  return <div ref={hostRef} className="composer-field-host relative min-w-0 flex-1">
    {props.children}
    {portalEntries.map((entry) => createPortal(<MentionChipFace of={entry.face} />, entry.element, entry.key))}
    {showHint && <span ref={hintRef} className="app-composer-hint-overlay" aria-hidden="true"><ComposerHint hint={props.hint!} /></span>}
  </div>;
}

const EXTERNAL = "composer-external";

type FieldElement = HTMLElement & { composerField?: ComposerField };

function attributesOf(props: ComposerEditorProps): Record<string, string> {
  return {
    class: props.className,
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": props.ariaLabel,
    "data-slot": "textarea",
    ...(props.disabled ? { "aria-disabled": "true" } : {}),
    spellcheck: "true",
    autocapitalize: "sentences",
  };
}

function keyEvent(event: KeyboardEvent): ComposerKeyEvent {
  return {
    key: event.key,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    nativeEvent: event,
    get defaultPrevented() {
      return event.defaultPrevented;
    },
    preventDefault: () => event.preventDefault(),
  };
}

function setText(view: EditorView, text: string, start: number, end: number, external: boolean) {
  const doc = composerDocFromText(text);
  const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
  const next = transaction.doc;
  transaction.setSelection(TextSelection.create(next, composerPosOf(next, start), composerPosOf(next, end)));
  if (external) transaction.setMeta(EXTERNAL, true).setMeta("addToHistory", false);
  view.dispatch(transaction);
}

/** Paste and drop carry text only: the lines become paragraphs. */
function replaceSelectionWithText(view: EditorView, text: string) {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const { state } = view;
  let transaction = state.tr.insertText(lines[0] ?? "", state.selection.from, state.selection.to);
  for (const line of lines.slice(1)) {
    transaction = transaction.split(transaction.selection.from);
    if (line) transaction = transaction.insertText(line);
  }
  view.dispatch(transaction.scrollIntoView());
}

type TextSnapshot = { text: string; start: number; end: number; at: number };

function snapshotOf(state: EditorState): TextSnapshot {
  return {
    text: composerTextOf(state.doc),
    start: composerOffsetOf(state.doc, state.selection.from),
    end: composerOffsetOf(state.doc, state.selection.to),
    at: Date.now(),
  };
}

/** Undo by text, as the textarea's was: typing within a short pause is one step. */
class TextHistory {
  private done: TextSnapshot[] = [];
  private undone: TextSnapshot[] = [];

  record(before: TextSnapshot) {
    const last = this.done.at(-1);
    this.undone = [];
    if (last && before.at - last.at < UNDO_GROUP_MS) {
      last.at = before.at;
      return;
    }
    this.done.push(before);
    if (this.done.length > 200) this.done.shift();
  }

  undo(current: TextSnapshot): TextSnapshot | undefined {
    const entry = this.done.pop();
    if (entry) this.undone.push(current);
    return entry;
  }

  redo(current: TextSnapshot): TextSnapshot | undefined {
    const entry = this.undone.pop();
    if (entry) this.done.push({ ...current, at: 0 });
    return entry;
  }
}

type PortalEntry = { key: string; element: HTMLElement; face: FaceOf };

/** The elements decorations drew that React fills: the chips' faces. */
class PortalRegistry {
  private entries = new Map<HTMLElement, PortalEntry>();
  private listeners = new Set<() => void>();
  private current: PortalEntry[] = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.current;

  add(entry: PortalEntry) {
    this.entries.set(entry.element, entry);
    this.changed();
  }

  remove(element: HTMLElement) {
    if (this.entries.delete(element)) this.changed();
  }

  private changed() {
    this.current = [...this.entries.values()];
    // Decorations are drawn inside a view update; let React render after it.
    queueMicrotask(() => {
      for (const listener of this.listeners) listener();
    });
  }
}

/**
 * The chips over the draft: each mention is the message's `.app-mention-chip`,
 * drawn as two halves that read as one pill, the face as a widget and the
 * `@name` as the decorated text, since a decoration cannot wrap a widget.
 */
function spanDecorations(propsRef: RefObject<ComposerEditorProps>, portals: PortalRegistry) {
  let cache: { text: string; inputs: unknown[]; set: DecorationSet } | null = null;
  return (state: EditorState): DecorationSet => {
    const props = propsRef.current!;
    const text = composerTextOf(state.doc);
    const inputs = [props.mentionIndex, props.currentUserIdentityId, props.references, props.summonReadings,
      props.summonReadingPending];
    if (cache && cache.text === text && inputs.every((input, index) => input === cache!.inputs[index])) return cache.set;
    const decorations: Decoration[] = [];
    const seen = new Map<string, number>();
    for (const span of draftSpans(text, props)) {
      const from = composerPosOf(state.doc, span.start);
      const to = composerPosOf(state.doc, span.end);
      if (to <= from) continue;
      const written = text.slice(span.start, span.end);
      const count = seen.get(written) ?? 0;
      seen.set(written, count + 1);
      const data = chipData(span);
      if (span.kind === "reference") {
        decorations.push(Decoration.inline(from, to, { nodeName: "span", class: "app-page-reference-chip", ...data }));
        continue;
      }
      const chip = span.self ? "app-mention-chip app-mention-chip-self" : "app-mention-chip";
      const face = span.face;
      if (face) {
        // Keyed by everything it draws but where it is, so a chip whose reading
        // changes is drawn again while typing before it only moves it.
        const drawn = Object.entries(data).filter(([name]) => name !== "data-start");
        const key = `face\u0000${written}\u0000${count}\u0000${JSON.stringify(face)}\u0000${chip}\u0000${JSON.stringify(drawn)}`;
        decorations.push(Decoration.widget(from, () => {
          const lead = document.createElement("span");
          lead.className = `${chip} app-composer-chip-lead`;
          lead.contentEditable = "false";
          // The colours the chip's state gives it; the text half alone is the addressable mention.
          for (const [name, value] of Object.entries(data)) {
            if (name !== "data-mention" && name !== "data-start") lead.setAttribute(name, value);
          }
          const avatar = document.createElement("span");
          avatar.className = "app-mention-chip-avatar";
          avatar.setAttribute("aria-hidden", "true");
          const element = document.createElement("span");
          element.className = "app-mention-chip-avatar-face";
          avatar.append(element);
          lead.append(avatar);
          portals.add({ key, element, face });
          return lead;
        }, { key, side: -1, ignoreSelection: true, destroy: (node) => {
          const element = (node as HTMLElement).querySelector<HTMLElement>(".app-mention-chip-avatar-face");
          if (element) portals.remove(element);
        } }));
      }
      decorations.push(Decoration.inline(from, to, {
        nodeName: "span", class: face ? `${chip} app-composer-chip-tail` : chip, ...data,
      }));
    }
    const set = DecorationSet.create(state.doc, decorations);
    cache = { text, inputs, set };
    return set;
  };
}

function draftSpans(text: string, props: ComposerEditorProps): readonly ComposerMentionSpan[] {
  if (!text) return NO_SPANS;
  const mentions = composerMentionSpans(text, props.mentionIndex, props.currentUserIdentityId);
  const picked = (props.references ?? []).filter((reference) => text.slice(reference.start, reference.end) === reference.text &&
    !mentions.some((span) => span.start < reference.end && reference.start < span.end))
    .map(({ start, end }): ComposerMentionSpan => ({ start, end, kind: "reference" }));
  const all = picked.length ? [...mentions, ...picked].sort((a, b) => a.start - b.start) : mentions;
  return all.map((span) => {
    if ((span.kind !== "summon" && span.kind !== "agent") || span.forced || span.invalid) return span;
    const reading = props.summonReadings?.find((item) => item.start === span.start && text.slice(item.start, item.end) === item.mention);
    if (reading) return { ...span, intent: reading.choice === "summon" ? "summon" as const : "declined" as const };
    return span.kind === "summon" && props.summonReadingPending ? { ...span, intent: "reading" as const } : span;
  });
}

function chipData(span: ComposerMentionSpan): Record<string, string> {
  return {
    "data-mention": "",
    "data-start": String(span.start),
    "data-kind": span.kind,
    ...(span.forced ? { "data-forced": "true" } : {}),
    ...(span.invalid ? { "data-invalid": "true" } : {}),
    ...(span.intent ? { "data-intent": span.intent } : {}),
  };
}

/** Faint words after the trigger they teach; keyed by text so each change rises in. */
function ComposerHint({ hint }: { hint: string }) {
  const parts = composerHintParts(hint);
  if (!parts) return <span data-testid="composer-hint" className="app-composer-hint">{hint}</span>;
  const words = (glint: boolean) => <>
    <span className="app-composer-hint-trigger">
      {glint && parts.trigger === "@" && <span className="app-composer-hint-sweep" aria-hidden="true" />}
      {parts.trigger}
    </span>{parts.rest}
  </>;
  return <span key={hint} className="app-composer-hint" data-rotating="true"
    data-summon={parts.trigger === "@" ? "true" : undefined}>
    <span data-testid="composer-hint" className="app-composer-hint-sharp">{words(true)}</span>
    <span className="app-composer-hint-blur" aria-hidden="true">{words(false)}</span>
  </span>;
}

/**
 * Draw the caret as a soft bar (globals.css, .app-composer-caret) and hide the
 * native one. It stands where the native caret would and restarts its fade on
 * every move. IME composition and touch screens keep the native caret: the
 * composition's own underline and the system's handles follow it.
 */
function softCaret(view: EditorView, host: HTMLElement): () => void {
  if (!window.matchMedia("(pointer: fine)").matches) return () => {};
  const input = view.dom;
  const caret = document.createElement("span");
  caret.className = "app-composer-caret";
  caret.hidden = true;
  caret.setAttribute("aria-hidden", "true");
  host.appendChild(caret);
  let composing = false;
  let at = "";
  const place = () => {
    const { selection } = view.state;
    const show = document.activeElement === input && !composing && view.editable && selection.empty;
    input.dataset.softCaret = composing ? "false" : "true";
    let box: { left: number; top: number; bottom: number } | undefined;
    if (show) {
      try {
        box = view.coordsAtPos(selection.head);
      } catch {
        box = undefined;
      }
    }
    caret.hidden = !box;
    if (!box) return;
    const hostBox = host.getBoundingClientRect();
    const scale = host.offsetWidth ? hostBox.width / host.offsetWidth || 1 : 1;
    const dpr = window.devicePixelRatio || 1;
    const height = (box.bottom - box.top) / scale;
    const left = Math.round(((box.left - hostBox.left) / scale - 1) * dpr) / dpr;
    const top = Math.round(((box.top - hostBox.top) / scale) * dpr) / dpr;
    const next = `${left}:${top}:${height}`;
    if (next === at) return;
    // A caret that just moved is solid; it starts fading only once it rests.
    if (at) for (const animation of caret.getAnimations()) if (animation instanceof CSSAnimation) animation.currentTime = 0;
    at = next;
    caret.style.height = `${height}px`;
    caret.style.transform = `translate(${left}px, ${top}px)`;
  };
  const compose = (event: CompositionEvent) => {
    composing = event.type === "compositionstart";
    place();
  };
  // A key or click moves the selection right after its listeners run, but
  // selectionchange can arrive a frame later; place again before that paint.
  let frame = 0;
  const soon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
  };
  place();
  document.addEventListener("selectionchange", soon);
  input.addEventListener("keydown", soon);
  input.addEventListener("mousedown", soon);
  input.addEventListener("input", soon);
  input.addEventListener("focus", place);
  input.addEventListener("blur", place);
  input.addEventListener("scroll", place);
  input.addEventListener("compositionstart", compose);
  input.addEventListener("compositionend", compose);
  const observer = new ResizeObserver(place);
  observer.observe(input);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("selectionchange", soon);
    input.removeEventListener("keydown", soon);
    input.removeEventListener("mousedown", soon);
    input.removeEventListener("input", soon);
    input.removeEventListener("focus", place);
    input.removeEventListener("blur", place);
    input.removeEventListener("scroll", place);
    input.removeEventListener("compositionstart", compose);
    input.removeEventListener("compositionend", compose);
    observer.disconnect();
    caret.remove();
    delete input.dataset.softCaret;
  };
}
