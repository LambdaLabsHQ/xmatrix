import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
