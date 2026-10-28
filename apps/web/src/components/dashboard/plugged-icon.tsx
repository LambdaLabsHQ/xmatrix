import { createLucideIcon } from "lucide-react";

/** Lucide's Unplug with its two halves pushed together: an app that is connected. */
export const Plugged = createLucideIcon("plugged", [
  ["path", { d: "M2 22 8 16", key: "cord-plug" }],
  ["path", { d: "M16 8 22 2", key: "cord-socket" }],
  ["path", { d: "M9.3 17.3a2.4 2.4 0 0 0 3.4 0L15 15l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z", key: "plug" }],
  ["path", { d: "m9 9 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z", key: "socket" }],
]);
