/** A directory-owned writer, separate from the Human Runtime sessions. */
export function catalogWriterPresence() {
  return { "writer-instance": { kind: "agent", label: "writer",
    registration: { ownerUserId: "owner", machineId: "machine", harness: "codex" },
    instances: [{ id: "writer-instance", channelInstanceId: "1", label: "writer:1",
      connectedAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-01T00:00:00Z", status: "idle" }] } };
}
