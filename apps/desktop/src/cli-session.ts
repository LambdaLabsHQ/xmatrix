export type { DesktopCliSessionPayload } from "@xmatrix/protocol";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DesktopCliSessionSaveResult = {
  ok: boolean;
  machineId?: string;
  updatedAt: string;
};

/** Atomic, owner-only JSON write for the App's own state files. */
export async function writePrivateJsonAtomic(filePath: string, value: unknown) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") {
      await fs.promises.chmod(temporaryPath, 0o600);
    }
    await fs.promises.rename(temporaryPath, filePath);
    if (process.platform !== "win32") {
      await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
