// Shared flock/residue implementation; Hub keeps its existing directory,
// batch tag and public test helper names.
export {
  HUB_TEST_SLOT_DIRECTORY,
  HUB_TEST_BATCH_ENV,
  batchProcesses,
  hostSlotsSupported as hubSlotsSupported,
  tryAcquireHostSlot as tryAcquireHubSlot,
  describeHostSlots as describeHubSlots,
} from "../../../scripts/host-task-slots.mjs";
