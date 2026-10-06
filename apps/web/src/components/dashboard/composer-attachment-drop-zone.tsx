"use client";

/**
 * The app's single file-drop surface.
 *
 * Drop handling lives on the document rather than on the composer element so
 * that every pixel of the window is a valid target. A composer registers as the
 * sink that receives the files; it no longer decides whether a drop is seen at
 * all. When nothing can accept files the overlay says so, because the failure
 * this replaces was a drop that produced no reaction whatsoever.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Paperclip } from "lucide-react";

import {
  dragCarriesFiles,
  nextDropDepth,
  pickDropSink,
  transferAttachmentCandidates,
} from "./composer-attachment-drop";
import type { DropSinkRegistration } from "./composer-attachment-drop";
import type { AttachmentIntakeCandidate } from "./composer-attachment-intake";

export type AttachmentDropCandidate = AttachmentIntakeCandidate<File>;

type SinkEntry = DropSinkRegistration & {
  label: string | null;
  onCandidates: (candidates: AttachmentDropCandidate[]) => void;
};

type DropZoneContextValue = {
  dragging: boolean;
  registerSink: (sink: Omit<SinkEntry, "seq">) => () => void;
  activeSinkId: string | null;
};

const DropZoneContext = createContext<DropZoneContextValue | null>(null);

export function AttachmentDropZoneProvider({ children }: { children: ReactNode }) {
  const sinksRef = useRef<Map<string, SinkEntry>>(new Map());
  const seqRef = useRef(0);
  const depthRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [sinkRevision, setSinkRevision] = useState(0);

  const registerSink = useCallback((sink: Omit<SinkEntry, "seq">) => {
    seqRef.current += 1;
    sinksRef.current.set(sink.id, { ...sink, seq: seqRef.current });
    setSinkRevision((current) => current + 1);
    return () => {
      sinksRef.current.delete(sink.id);
      setSinkRevision((current) => current + 1);
    };
  }, []);

  const activeSink = useMemo(() => {
    void sinkRevision;
    return pickDropSink([...sinksRef.current.values()]) as SinkEntry | null;
  }, [sinkRevision]);

  useEffect(() => {
    function resetDrag() {
      depthRef.current = nextDropDepth(depthRef.current, "reset");
      setDragging(false);
    }

    function handleDragEnter(event: DragEvent) {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      // Claiming the drag here is what stops the browser from taking the drop
      // and navigating (or, in the desktop shell, silently discarding it).
      event.preventDefault();
      depthRef.current = nextDropDepth(depthRef.current, "enter");
      setDragging(true);
    }

    function handleDragOver(event: DragEvent) {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = sinksRef.current.size > 0 ? "copy" : "none";
      }
      // A drag that began before this listener mounted (or over a child that
      // swallowed dragenter) still has to light the overlay.
      if (depthRef.current === 0) {
        depthRef.current = nextDropDepth(depthRef.current, "enter");
        setDragging(true);
      }
    }

    function handleDragLeave(event: DragEvent) {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      depthRef.current = nextDropDepth(depthRef.current, "leave");
      if (depthRef.current === 0) setDragging(false);
    }

    function handleDrop(event: DragEvent) {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      resetDrag();

      const sink = pickDropSink([...sinksRef.current.values()]) as SinkEntry | null;
      if (!sink) return;
      const candidates = transferAttachmentCandidates<File>({
        items: event.dataTransfer?.items,
        files: event.dataTransfer?.files,
      });
      if (candidates.length === 0) return;
      sink.onCandidates(candidates);
    }

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragend", resetDrag);
    window.addEventListener("blur", resetDrag);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", resetDrag);
      window.removeEventListener("blur", resetDrag);
    };
  }, []);

  const value = useMemo<DropZoneContextValue>(
    () => ({ dragging, registerSink, activeSinkId: activeSink?.id ?? null }),
    [activeSink?.id, dragging, registerSink]
  );

  return (
    <DropZoneContext.Provider value={value}>
      {children}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary px-8 py-6 text-center">
            <Paperclip className="size-7 text-primary" />
            <div className="text-base font-bold text-foreground">
              {activeSink
                ? activeSink.label
                  ? `Drop files to attach to ${activeSink.label}`
                  : "Drop files to attach"
                : "Open a channel to attach files"}
            </div>
            <div className="text-xs text-muted-foreground">
              {activeSink ? "Anywhere in this window works." : "Files can only attach to a message you can send."}
            </div>
          </div>
        </div>
      )}
    </DropZoneContext.Provider>
  );
}

/**
 * Registers the caller as the drop sink while `active`. Returns the drag state
 * so the composer can highlight itself without owning any drag listeners.
 */
export function useAttachmentDropSink(input: {
  id: string;
  active: boolean;
  priority: number;
  label?: string | null;
  onCandidates: (candidates: AttachmentDropCandidate[]) => void;
}): { dragging: boolean; isDropTarget: boolean } {
  const context = useContext(DropZoneContext);
  const handlerRef = useRef(input.onCandidates);
  handlerRef.current = input.onCandidates;

  const { id, active, priority, label } = input;
  const registerSink = context?.registerSink;

  useEffect(() => {
    if (!registerSink || !active) return;
    return registerSink({
      id,
      priority,
      label: label ?? null,
      onCandidates: (candidates) => handlerRef.current(candidates),
    });
  }, [active, id, label, priority, registerSink]);

  return {
    dragging: context?.dragging === true,
    isDropTarget: context?.dragging === true && context?.activeSinkId === id,
  };
}
