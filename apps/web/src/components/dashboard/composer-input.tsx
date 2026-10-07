"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { stripEmptyPasteSentinel } from "./composer-caret";
import { ComposerTextHighlight } from "./composer-text-highlight";
import { channelMentionCandidates } from "./mention-complete";
import { buildMentionReadIndex } from "./mention-read-state";
import { ComposerSummonIntent } from "./composer-summon-intent";

export type ComposerInputAuthorityProps = ComposerContextFields & {
  /** Picked channel and page references in the draft, highlighted as the chips they send as. */
  referenceRanges?: ReadonlyArray<{ start: number; end: number; text: string }>;
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
  onKeyDownExtra?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  boxClassName?: string;
  onBoxPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  disabled?: boolean;
  /** Live completion API for parent-only features (mention insert, empty-paste cursor). */
  completionApiRef?: React.MutableRefObject<ComposerCompletionApi | null>;
  textareaValue?: string;
  onTextareaChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaBeforeInput?: (event: React.FormEvent<HTMLTextAreaElement>) => void;
  onTextareaCompositionStart?: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
  onTextareaFocus?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
  onTextareaBlur?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
  onTextareaTouchStart?: (event: React.TouchEvent<HTMLTextAreaElement>) => void;
  onTextareaPointerDown?: (event: React.PointerEvent<HTMLTextAreaElement>) => void;
  onTextareaPointerUp?: (event: React.PointerEvent<HTMLTextAreaElement>) => void;
  onTextareaClick?: (event: ReactMouseEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  sendTitle?: string;
  formClassName?: string;
  shellClassName?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
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
  textareaValue,
  onTextareaChange,
  onTextareaBeforeInput,
  onTextareaCompositionStart,
  onTextareaFocus,
  onTextareaBlur,
  onTextareaTouchStart,
  onTextareaPointerDown,
  onTextareaPointerUp,
  onTextareaClick,
  onTextareaPaste,
  sendTitle,
  formClassName,
  shellClassName,
  textareaRef: textareaRefProp,
}: ComposerInputAuthorityProps) {
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = textareaRefProp ?? internalTextareaRef;
  const boxRef = useRef<HTMLElement | null>(null);
  const { user } = useAuth();
  // The draft paints what the timeline will chip, from the same member index.
  const mentionIndex = useMemo(() => buildMentionReadIndex(
    channelMentionCandidates(channel, localContext, [], space, instanceTargetScope)), [channel, localContext, space, instanceTargetScope]);
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
    textareaRef,
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
    const textarea = textareaRef.current;
    const activeElement = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      if (!textarea || textareaRef.current !== textarea) return;
      if (document.activeElement !== activeElement && document.activeElement !== textarea) return;
      textarea.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, textareaRef]);

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
        <ComposerSummonIntent draft={textareaValue ?? draft} onDraftChange={onDraftChange} textareaRef={textareaRef} />
        {/* One capsule: attach, text, actions and send share the glass. When
            the text wraps or a header shows, the same surface grows into a
            panel and the controls stay on its bottom edge. */}
        <div className="composer-input-row flex min-w-0 items-end gap-2">
          {inputLeading}
          <div className="relative min-w-0 flex-1">
          <ComposerTextHighlight value={textareaValue ?? draft} textareaRef={textareaRef}
            mentionIndex={mentionIndex} currentUserIdentityId={user ? `user:${user.id}` : undefined}
            references={referenceRanges}
            hint={stripEmptyPasteSentinel(textareaValue ?? draft).length === 0 ? placeholder : undefined} />
          <Textarea
            ref={textareaRef}
            value={textareaValue ?? draft}
            onChange={(event) => {
              if (onTextareaChange) {
                onTextareaChange(event);
                return;
              }
              onDraftChange(event.target.value);
              completion.syncCursor(event.target);
            }}
            onBeforeInput={onTextareaBeforeInput}
            onCompositionStart={onTextareaCompositionStart}
            onFocus={onTextareaFocus}
            onBlur={onTextareaBlur}
            onTouchStart={onTextareaTouchStart}
            onPointerDown={onTextareaPointerDown}
            onPointerUp={onTextareaPointerUp}
            onClick={(event) => {
              onTextareaClick?.(event);
              completion.syncCursor(event.currentTarget);
            }}
            onKeyUp={(event) => completion.syncCursor(event.currentTarget)}
            onPaste={onTextareaPaste}
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
            aria-label={ariaLabel}
            className={cn(
              "composer-textarea flex-1 resize-none border-0 bg-transparent shadow-none outline-none transition-all duration-200 focus-visible:ring-0",
              compact ? "min-h-0 p-0 text-sm" : "min-h-9 px-0 py-1.5 text-sm sm:min-h-11 sm:py-2 sm:text-[15px]"
            )}
          />
          </div>
          {inputTrailing}
          <button
            type={compact ? "submit" : "button"}
            title={sendTitle ?? "Send"}
            aria-label={sendTitle ?? "Send"}
            disabled={disabled || !enabled || !readyToSend || sending}
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
              <Loader2 className="size-5 animate-spin" />
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
