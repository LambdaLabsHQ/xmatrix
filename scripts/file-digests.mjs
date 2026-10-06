import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function digestFile(filePath, algorithms) {
  const uniqueAlgorithms = [...new Set(algorithms)];
  if (uniqueAlgorithms.length === 0) throw new Error("Expected at least one file digest algorithm");
  const digests = new Map(uniqueAlgorithms.map((algorithm) => [algorithm, createHash(algorithm)]));
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => {
      for (const digest of digests.values()) digest.update(chunk);
    });
    input.on("error", reject);
    input.on("end", resolve);
  });
  return Object.fromEntries([...digests].map(([algorithm, digest]) => [algorithm, digest.digest()]));
}
