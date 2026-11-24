"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, Loader2, PlugZap, } from "lucide-react";
import {
  handleComposerTextareaKeyDown,
  useComposerCompletion,
  type ComposerCompletionApi,
  type ComposerContextFields,
} from "@/components/dashboard/composer-completion";
import { LiquidGlassSurface } from "@/components/ui/liquid-glass-surface";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { stripEmptyPasteSentinel } from "./composer-caret";
import { ComposerEditor, type ComposerField, type ComposerKeyEvent } from "./composer-editor";
import { channelMentionCandidates } from "./mention-complete";
import { buildMentionReadIndex } from "./mention-read-state";

export type ComposerInputAuthorityProps = ComposerContextFields & {
  /** Picked channel and page references in the draft, highlighted as the chips they send as. */
  referenceRanges?: ReadonlyArray<{ start: number; end: number; text: string }>;
  /** Whether a quote in the draft is of a message in this conversation (composer-blocks.ts). */
  quoteIsHere?: (href: string) => boolean;
  /** A picture of the draft as the composer draws its attachment (composer-blocks.ts). */
  renderPicture?: (ref: string) => ReactNode;
  onSend: () => void;
  /** Escape cancels (thread draft) or is unused (main composer). */
  onEscape?: () => void;
  sending?: boolean;
  canSend?: boolean;
  placeholder: string;
  ariaLabel: string;
  /** Compact thread-inline styles vs main channel composer. */
  density?: "default" | "compact";
  autoFocus?: boolean;
  /**
   * Content above the shared completion chrome / textarea inside the glass box
   * (reply banner, attachments, drop overlay). Workspace/app mention chips are
   * rendered by this component so both call sites stay identical.
   */
  boxHeader?: ReactNode;
  /** Icons before the textarea inside the input row (main composer attach). */
  inputLeading?: ReactNode;
  /** Icons after the textarea inside the input row (mention, summon). */
  inputTrailing?: ReactNode;
  /** Controls after the send button (thread cancel). */
  afterSend?: ReactNode;
  /** A list the composer shows in place of completion (input history, attachment sources); it takes the box's open panel shape. */
  panel?: ReactNode;
  /** Stable key naming the active `panel` so switching between panels also triggers a smooth height morph. */
  panelKey?: string;
  /** Where completion and auxiliary panels expand relative to the input row. Defaults to `"above"` for bottom-docked chat composers. */
  panelPlacement?: "above" | "below";
  /** Key handling before completion and Enter-to-send, for the `panel`'s own keys; true when it took the key. */
  onKeyDownFirst?: (event: ComposerKeyEvent) => boolean;
  /** Extra key handling after shared completion/enter (e.g. attachment backspace). */
  onKeyDownExtra?: (event: ComposerKeyEvent) => void;
  boxClassName?: string;
  onBoxPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  disabled?: boolean;
  /** Live completion API for parent-only features (mention insert, empty-paste cursor). */
  completionApiRef?: React.MutableRefObject<ComposerCompletionApi | null>;
  /** What the field shows when it differs from the draft (the empty-paste anchor). */
  fieldValue?: string;
  onFieldChange?: (value: string, field: ComposerField) => void;
  onFieldBeforeInput?: (event: InputEvent, field: ComposerField) => void;
  onFieldCompositionStart?: (field: ComposerField) => void;
  onFieldFocus?: (field: ComposerField) => void;
  onFieldBlur?: (field: ComposerField) => void;
  onFieldTouchStart?: (field: ComposerField) => void;
  onFieldPointerDown?: (event: PointerEvent, field: ComposerField) => void;
  onFieldPointerUp?: (event: PointerEvent, field: ComposerField) => void;
  onFieldClick?: (field: ComposerField) => void;
  onFieldPaste?: (event: ClipboardEvent, field: ComposerField) => void;
  sendTitle?: string;
  /** Icon inside the primary send button; defaults to the upward send arrow for chat timelines. */
  sendIcon?: ReactNode;
  formClassName?: string;
  shellClassName?: string;
  fieldRef?: React.RefObject<ComposerField | null>;
};

/**
 * Shared text input surface for channel composer and Reply-in-thread draft.
 * Owns completion, Enter-to-send, glass box chrome, and the send control so both
 * call sites cannot drift into parallel keyboard/completion implementations.
 */
export function ComposerInputAuthority(props: ComposerInputAuthorityProps) {
  return <ComposerInputSurface {...props} />;
}

function ComposerInputSurface({
  draft,
  onDraftChange,
  onInvocationSelect,
  onReferenceSelect,
  referenceRanges,
  quoteIsHere,
  renderPicture,
  channel,
  space,
  token,
  workspaces,
  localContext,
  enabled,
  instanceTargetScope,
  onSend,
  onEscape,
  sending = false,
  canSend,
  placeholder,
  ariaLabel,
  density = "default",
  autoFocus = false,
  selectedWorkspaceId = null,
  onWorkspaceSelect,
  onConfigureAppConnector,
  onEditHarnessProfile,
  boxHeader,
  inputLeading,
  inputTrailing,
  afterSend,
  panel,
  panelKey,
  panelPlacement = "above",
  onKeyDownFirst,
  onKeyDownExtra,
  boxClassName,
  onBoxPointerDown,
  disabled = false,
  completionApiRef,
  fieldValue,
  onFieldChange,
  onFieldBeforeInput,
  onFieldCompositionStart,
  onFieldFocus,
  onFieldBlur,
  onFieldTouchStart,
  onFieldPointerDown,
  onFieldPointerUp,
  onFieldClick,
  onFieldPaste,
  sendTitle,
  sendIcon,
  formClassName,
  shellClassName,
  fieldRef: fieldRefProp,
}: ComposerInputAuthorityProps) {
  const internalFieldRef = useRef<ComposerField | null>(null);
  const fieldRef = fieldRefProp ?? internalFieldRef;
  const boxRef = useRef<HTMLElement | null>(null);
  const { user } = useAuth();
  // Plain text has no addresses to paint. Do not rebuild the interaction
  // registry on every activity report until a draft actually contains one.
  const hasMention = /[@＠]/u.test(fieldValue ?? draft);
  const mentionIndex = useMemo(() => hasMention ? buildMentionReadIndex(
    channelMentionCandidates(channel, localContext, [], space, instanceTargetScope)) : null,
  [hasMention, channel, localContext, space, instanceTargetScope]);
  const completion = useComposerCompletion({
    draft,
    onDraftChange,
    onInvocationSelect,
    onReferenceSelect,
    channel,
    space,
    token,
    workspaces,
    localContext,
    enabled,
    instanceTargetScope,
    fieldRef,
    panelPlacement,
    selectedWorkspaceId,
    onWorkspaceSelect,
    onConfigureAppConnector,
    onEditHarnessProfile,
  });

  if (completionApiRef) {
    completionApiRef.current = completion;
  }

  // Any composer panel (completion, input history, attachment sources) morphs
  // out of the capsule: the glass box itself grows from the height it had to
  // the panel's (or back), with its content pinned to the bottom edge and
  // revealed as it grows, as the work dock's island grows into its panel.
  // Interrupting an in-flight morph reads the box's current animated height so
  // rapid toggles never snap.
  const settledBoxHeightRef = useRef<number | null>(null);
  const activeMorphAnimationRef = useRef<Animation | null>(null);
  const pendingMorphCleanupRef = useRef<Animation | null>(null);
  const latestPanelRef = useRef<{ key: string; node: ReactNode } | null>(null);
  const [closingPanel, setClosingPanel] = useState<ReactNode>(null);
  if (!completion.isCompletionOpen && panel) {
    latestPanelRef.current = { key: panelKey ?? "panel", node: panel };
  }
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      if (!activeMorphAnimationRef.current && !pendingMorphCleanupRef.current) {
        settledBoxHeightRef.current = box.getBoundingClientRect().height;
      }
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      const active = activeMorphAnimationRef.current;
      activeMorphAnimationRef.current = null;
      active?.cancel();
      const pending = pendingMorphCleanupRef.current;
      pendingMorphCleanupRef.current = null;
      pending?.cancel();
    };
  }, []);
  const morphStateKey = completion.isCompletionOpen ? "completion" : panel ? (panelKey ?? "panel") : "closed";
  const panelOpen = morphStateKey !== "closed";
  const prevMorphStateKeyRef = useRef(morphStateKey);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const previousKey = prevMorphStateKeyRef.current;
    if (previousKey === morphStateKey) {
      if (settledBoxHeightRef.current === null && !activeMorphAnimationRef.current && !pendingMorphCleanupRef.current) {
        settledBoxHeightRef.current = box.getBoundingClientRect().height;
      }
      return;
    }
    prevMorphStateKeyRef.current = morphStateKey;
    const active = activeMorphAnimationRef.current;
    const pending = pendingMorphCleanupRef.current;
    const from = (active || pending) ? box.getBoundingClientRect().height : settledBoxHeightRef.current;
    activeMorphAnimationRef.current = null;
    pendingMorphCleanupRef.current = null;
    active?.cancel();
    pending?.cancel();
    const to = box.getBoundingClientRect().height;
    settledBoxHeightRef.current = to;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      || Boolean(box.closest("[data-ask-surface]"));
    if (from === null || Math.abs(to - from) < 1 || reducedMotion) {
      box.classList.remove("app-composer-box-morphing");
      setClosingPanel(null);
      return;
    }
    const holdClosingPanel = !panelOpen && previousKey !== "completion" && Boolean(latestPanelRef.current);
    setClosingPanel(holdClosingPanel ? latestPanelRef.current!.node : null);
    box.classList.add("app-composer-box-morphing");
    const animation = box.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      panelOpen
        ? { duration: 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
        : {
            duration: 220,
            easing: "cubic-bezier(0.4, 0, 0.2, 1)",
            fill: holdClosingPanel ? "forwards" : "none",
          }
    );
    activeMorphAnimationRef.current = animation;
    animation.onfinish = () => {
      if (activeMorphAnimationRef.current !== animation) return;
      activeMorphAnimationRef.current = null;
      if (holdClosingPanel) {
        // Keep the `fill: "forwards"` closed height and `.app-composer-box-morphing`
        // until React removes `closingPanel` from the DOM; releasing earlier lets
        // the box flash back to its open height and spike `--app-composer-height`.
        pendingMorphCleanupRef.current = animation;
        setClosingPanel(null);
        return;
      }
      box.classList.remove("app-composer-box-morphing");
    };
    animation.oncancel = () => {
      if (activeMorphAnimationRef.current !== animation) return;
      activeMorphAnimationRef.current = null;
      box.classList.remove("app-composer-box-morphing");
      if (holdClosingPanel) setClosingPanel(null);
    };
  }, [morphStateKey, panelOpen]);

  useLayoutEffect(() => {
    if (closingPanel !== null) return;
    const pending = pendingMorphCleanupRef.current;
    if (!pending) return;
    pendingMorphCleanupRef.current = null;
    pending.cancel();
    if (!activeMorphAnimationRef.current) {
      boxRef.current?.classList.remove("app-composer-box-morphing");
    }
  }, [closingPanel]);

  useEffect(() => {
    if (!autoFocus) return;
    const field = fieldRef.current;
    const activeElement = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      if (!field || fieldRef.current !== field) return;
      if (document.activeElement !== activeElement && document.activeElement !== field.element) return;
      field.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, fieldRef]);

  const readyToSend = (canSend ?? (draft.trim().length > 0 && !sending && enabled));
  const compact = density === "compact";
  const appMentions = completion.appMentions;

  const overlayPanel = (
    <>
      {completion.isCompletionOpen ? completion.renderOverlays() : panel}
      {!panelOpen && closingPanel && (
        <div
          aria-hidden="true"
          className="app-composer-panel-closing pointer-events-none [animation:app-composer-attach-out_170ms_cubic-bezier(0.4,0,0.2,1)_forwards] motion-reduce:animate-none [&_.app-composer-attach-menu]:!animate-none"
        >
          {closingPanel}
        </div>
      )}
    </>
  );

  const body = (
    <div
      className={cn(
        compact
          ? "flex min-w-0 flex-1 items-end gap-2"
          : "app-composer-shell flex min-w-0 flex-1 items-end gap-2 sm:gap-3",
        shellClassName
      )}
    >
      <LiquidGlassSurface
        ref={boxRef}
        fill
        data-panel-placement={panelPlacement}
        style={panelPlacement === "below" ? { ["--app-composer-morph-justify" as string]: "flex-start" } : undefined}
        className={cn(
          "app-composer-box app-material-liquid-pill relative min-w-0 flex-1 border border-input bg-card shadow-sm transition-colors duration-200 focus-within:border-ring",
          (completion.isCompletionOpen || panel) && "app-composer-box-mentions-open",
          boxClassName
        )}
        onPointerDown={onBoxPointerDown}
      >
        {boxHeader}
        {appMentions.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-border/70 px-3 py-2">
            {appMentions.map((mention) => (
              <span
                key={`${mention.appId}:${mention.actionId || "default"}`}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded px-2 py-1 text-xs font-bold",
                  mention.status === "available"
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                )}
              >
                <PlugZap className="size-3.5 shrink-0" />
                <span className="truncate">
                  {mention.appName}
                  {mention.actionLabel ? `: ${mention.actionLabel}` : ""}
                </span>
              </span>
            ))}
          </div>
        )}
        {panelPlacement === "above" && overlayPanel}
        {/* One capsule: attach, text, actions and send share the glass. When
            the text wraps or a header shows, the same surface grows into a
            panel and the controls stay on its anchored edge. */}
        <div className="composer-input-row flex min-w-0 items-end gap-2">
          {inputLeading}
          <ComposerEditor
            fieldRef={fieldRef}
            value={fieldValue ?? draft}
            onChange={(value, field) => {
              if (onFieldChange) {
                onFieldChange(value, field);
                return;
              }
              onDraftChange(value);
              completion.syncCursor(field);
            }}
            onSelect={completion.syncCursor}
            onBeforeInput={onFieldBeforeInput}
            onCompositionStart={onFieldCompositionStart}
            onFocus={onFieldFocus}
            onBlur={onFieldBlur}
            onTouchStart={onFieldTouchStart}
            onPointerDown={onFieldPointerDown}
            onPointerUp={onFieldPointerUp}
            onClick={(field) => {
              onFieldClick?.(field);
              completion.syncCursor(field);
            }}
            onPaste={onFieldPaste}
            disabled={disabled || !enabled}
            onKeyDown={(event) => {
              if (onKeyDownFirst?.(event)) return;
              if (
                handleComposerTextareaKeyDown(event, {
                  handleCompletionKeyDown: completion.handleCompletionKeyDown,
                  onSend,
                  onEscape,
                })
              ) {
                return;
              }
              onKeyDownExtra?.(event);
            }}
            ariaLabel={ariaLabel}
            className={cn(
              "composer-textarea flex-1 resize-none border-0 bg-transparent shadow-none outline-none transition-[background-color,border-color,box-shadow,opacity] duration-200 focus-visible:ring-0",
              compact ? "min-h-0 p-0 text-sm" : "min-h-9 px-0 py-1.5 text-sm sm:min-h-11 sm:py-2 sm:text-[15px]"
            )}
            mentionIndex={mentionIndex} currentUserIdentityId={user ? `user:${user.id}` : undefined}
            references={referenceRanges}
            quoteIsHere={quoteIsHere}
            renderPicture={renderPicture}
            hint={stripEmptyPasteSentinel(fieldValue ?? draft).length === 0 ? placeholder : undefined} />
          {inputTrailing}
          <button
            type={compact ? "submit" : "button"}
            title={sendTitle ?? "Send"}
            aria-label={sendTitle ?? "Send"}
            disabled={disabled || !enabled || !readyToSend || sending}
            // Pressing Send leaves focus in the field, not on the button.
            onMouseDown={(event) => event.preventDefault()}
            onClick={
              compact
                ? undefined
                : () => {
                    if (readyToSend) onSend();
                  }
            }
            className={cn(
              "app-composer-send flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors disabled:pointer-events-none disabled:*:opacity-40",
              readyToSend && "app-composer-send-ready"
            )}
          >
            {sending ? (
              <AnimatedIcon icon={Loader2} className="size-5 animate-spin" />
            ) : (
              sendIcon ?? <ArrowUp className="size-5" strokeWidth={2.5} />
            )}
          </button>
        </div>
        {panelPlacement === "below" && overlayPanel}
      </LiquidGlassSurface>
      {afterSend}
    </div>
  );

  if (!compact) return body;

  return (
    <form
      className={cn("mt-2 flex max-w-2xl items-end gap-2 pl-3", formClassName)}
      onSubmit={(event) => {
        event.preventDefault();
        if (readyToSend) onSend();
      }}
    >
      {body}
    </form>
  );
}
