/** The small persistence contract of fact-free per-Space alarm clocks. */
export interface SpaceClockStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: string): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** Keep an existing earlier wake; compute the deadline after the storage read. */
export async function armEarlierSpaceAlarm(storage: SpaceClockStorage, spaceId: string,
  deadline: () => number): Promise<void> {
  await storage.put("spaceId", spaceId);
  const alarm = await storage.getAlarm();
  const at = deadline();
  if (alarm === null || alarm > at) await storage.setAlarm(at);
}

/** An alarm must find the Space pinned by its arm operation before doing domain work. */
export async function requireSpaceClockSpace(storage: SpaceClockStorage, missing: string): Promise<string> {
  const spaceId = await storage.get<string>("spaceId");
  if (!spaceId) throw new Error(missing);
  return spaceId;
}
