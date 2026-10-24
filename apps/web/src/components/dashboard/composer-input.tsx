"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { ArrowUp, Loader2, PlugZap, } from "lucide-react";
import { ComposerSummonOptions } from "./composer-summon-options";
import type { DraftSummonIntent } from "@xmatrix/protocol";
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
  /** Jev's reading of each summon in the draft, painted on its band; declined mentions offer options at their address. */
  summonReadings?: ReadonlyArray<DraftSummonIntent>;
  /** A reading for the current draft is still on its way. */
  summonReadingPending?: boolean;
  onSummonStartAnyway?: (reading: DraftSummonIntent) => void;
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
  summonReadings,
  summonReadingPending,
  onSummonStartAnyway,
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
  boxHeader,
  inputLeading,
  inputTrailing,
  afterSend,
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
    selectedWorkspaceId,
    onWorkspaceSelect,
    onConfigureAppConnector,
  });

  if (completionApiRef) {
    completionApiRef.current = completion;
  }

  // The completion panel morphs out of the capsule: the glass box itself
  // grows from the height it had to the panel's (or back), with its content
  // pinned to the bottom edge and revealed as it grows, as the work dock's
  // island grows into its panel. The box's last settled height is kept so
  // the change can start from it.
  const settledBoxHeightRef = useRef<number | null>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      if (!box.getAnimations().length) settledBoxHeightRef.current = box.getBoundingClientRect().height;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const completionOpen = completion.isCompletionOpen;
  useLayoutEffect(() => {
    const box = boxRef.current;
    const from = settledBoxHeightRef.current;
    if (!box || from === null) return;
    const to = box.getBoundingClientRect().height;
    settledBoxHeightRef.current = to;
    if (Math.abs(to - from) < 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const running of box.getAnimations()) running.cancel();
    box.classList.add("app-composer-box-morphing");
    const animation = box.animate([{ height: `${from}px` }, { height: `${to}px` }], completionOpen
      ? { duration: 360, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
      : { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
    const settle = () => box.classList.remove("app-composer-box-morphing");
    animation.onfinish = settle;
    animation.oncancel = settle;
  }, [completionOpen]);

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
        className={cn(
          "app-composer-box app-material-liquid-pill relative min-w-0 flex-1 border border-input bg-card shadow-sm transition-all duration-200 focus-within:border-ring",
          completion.isCompletionOpen && "app-composer-box-mentions-open",
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
        {completion.renderOverlays()}
        {/* One capsule: attach, text, actions and send share the glass. When
            the text wraps or a header shows, the same surface grows into a
            panel and the controls stay on its bottom edge. */}
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
            references={referenceRanges} summonReadings={summonReadings} summonReadingPending={summonReadingPending}
            hint={stripEmptyPasteSentinel(fieldValue ?? draft).length === 0 ? placeholder : undefined}>
            {onSummonStartAnyway && summonReadings?.some(reading => reading.choice !== "summon") &&
              <ComposerSummonOptions readings={summonReadings}
              fieldRef={fieldRef} disabled={disabled || !enabled || sending} onStartAnyway={onSummonStartAnyway} />}
          </ComposerEditor>
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
              <ArrowUp className="size-5" strokeWidth={2.5} />
            )}
          </button>
        </div>
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
