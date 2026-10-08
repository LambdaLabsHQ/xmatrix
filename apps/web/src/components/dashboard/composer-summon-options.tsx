"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { X, Zap } from "lucide-react";
import type { DraftSummonIntent } from "@xmatrix/protocol";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { useAppPortalContainer } from "./app-portal-container";

type PositionedReading = { reading: DraftSummonIntent; left: number; top: number; width: number; height: number };

/** Only declined mentions get an interactive underline. The hint opens at
 * the address itself; normal summons leave the input free of extra copy. */
export function ComposerSummonOptions({ readings, textareaRef, disabled, onStartAnyway }: {
  readings: ReadonlyArray<DraftSummonIntent>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  onStartAnyway: (reading: DraftSummonIntent) => void;
}) {
  const [positions, setPositions] = useState<PositionedReading[]>([]);
  useLayoutEffect(() => {
    const input = textareaRef.current;
    const host = input?.parentElement;
    if (!input || !host) return;
    const sync = () => {
      const hostBox = host.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const scale = input.offsetWidth ? inputBox.width / input.offsetWidth || 1 : 1;
      const next = readings.flatMap(reading => {
        if (reading.choice === "summon" || input.value.slice(reading.start, reading.end) !== reading.mention) return [];
        const span = host.querySelector<HTMLElement>(`[data-mention][data-start="${reading.start}"]`);
        const text = span?.firstChild;
        if (!(text instanceof Text)) return [];
        const address = reading.mention.split(/\s/u)[0]!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, address.length);
        const box = [...range.getClientRects()].find(rect => rect.width > 0);
        if (!box || box.top < inputBox.top || box.bottom > inputBox.bottom + 1 ||
            box.right <= inputBox.left || box.left >= inputBox.right) return [];
        return [{ reading, left: (box.left - hostBox.left) / scale, top: (box.top - hostBox.top) / scale,
          width: box.width / scale, height: box.height / scale }];
      });
      setPositions(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    input.addEventListener("scroll", sync);
    document.fonts?.addEventListener("loadingdone", sync);
    return () => {
      observer.disconnect();
      input.removeEventListener("scroll", sync);
      document.fonts?.removeEventListener("loadingdone", sync);
    };
  }, [readings, textareaRef]);
  return <div className="pointer-events-none absolute inset-0 z-10">
    {positions.map(position => <DeclinedSummonOption key={`${position.reading.start}:${position.reading.end}`}
      position={position} disabled={disabled} onStartAnyway={onStartAnyway} />)}
  </div>;
}

function DeclinedSummonOption({ position, disabled, onStartAnyway }: {
  position: PositionedReading; disabled?: boolean; onStartAnyway: (reading: DraftSummonIntent) => void;
}) {
  const portal = useAppPortalContainer();
  const { reading, left, top, width, height } = position;
  const address = reading.mention.split(/\s/u)[0];
  return <Popover.Root>
    <Popover.Trigger ref={portal.triggerRef} openOnHover delay={250} closeDelay={180}
      className="app-composer-summon-declined" data-testid="composer-summon-declined" data-start={reading.start}
      style={{ left, top, width, height }} disabled={disabled}
      aria-label={`${address}: xMatrix thinks this sentence is not asking to start an Agent. Show options`}
      onMouseDown={event => event.preventDefault()} />
    <Popover.Portal container={portal.container}>
      <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={12} className="app-invocation-positioner">
        <Popover.Popup render={<LiquidGlassCard />} className="app-invocation-popup app-composer-summon-popup" data-tone="neutral">
          <div className="app-invocation-heading">
            <Popover.Title className="app-invocation-title">{address}</Popover.Title>
            <Popover.Close className="app-invocation-close" aria-label="Close"><X size={16} /></Popover.Close>
          </div>
          <Popover.Description className="app-composer-summon-explanation">
            xMatrix thinks this sentence is not asking to start an Agent.
          </Popover.Description>
          <button type="button" className="app-intent-launch" disabled={disabled}
            aria-description="Start this Agent when you send the message"
            onClick={() => onStartAnyway(reading)}>
            <Zap size={16} aria-hidden="true" />Start anyway
          </button>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
