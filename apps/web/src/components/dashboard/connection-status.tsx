"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { humanPushConnected } from "./workspace-resource-push";

/** A dropped connection that recovers within this is not worth a word. */
const RECONNECT_NOTICE_DELAY_MS = 4_000;

/** The browser's online/offline signal, for useSyncExternalStore. */
export function subscribeToNetwork(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Whether the live connection is down, from the Human socket's own signal
 * (`setHumanPushConnected`). Until it has connected once, startup owns the
 * wait (StartupShell), so this stays quiet.
 */
function useLiveConnectionDown(): boolean {
  const [state, setState] = useState(() => {
    const connected = humanPushConnected();
    return { everConnected: connected, connected };
  });
  useEffect(() => {
    const onPush = (event: Event) => {
      const connected = (event as CustomEvent<{ connected: boolean }>).detail?.connected === true;
      setState((current) => ({ everConnected: current.everConnected || connected, connected }));
    };
    window.addEventListener("xmatrix:human-push", onPush);
    return () => window.removeEventListener("xmatrix:human-push", onPush);
  }, []);
  return state.everConnected && !state.connected;
}

/**
 * What the app is waiting for once it is open: one tile of tinted paper under
 * the top band, only while it is true. Offline says so at once; a dropped live
 * connection says it is reconnecting once the drop outlasts a blip. Everything
 * on screen stays usable; new messages catch up when the connection returns.
 */
export function ConnectionStatus() {
  const online = useSyncExternalStore(subscribeToNetwork, () => navigator.onLine, () => true);
  const down = useLiveConnectionDown();
  const [noticeDue, setNoticeDue] = useState(false);
  useEffect(() => {
    if (!down) {
      setNoticeDue(false);
      return;
    }
    const timer = window.setTimeout(() => setNoticeDue(true), RECONNECT_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [down]);

  const message = !online
    ? "You’re offline. New messages will arrive when the network is back."
    : down && noticeDue
      ? "Reconnecting to xMatrix…"
      : null;
  if (!message) return null;
  return (
    <div className="app-connection-status" role="status">
      <span className="app-paper-tile">{message}</span>
    </div>
  );
}
