import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { CARD, cardWords, wordsDrawnOn } from "./share-card.mjs";

test("the share card shows the site's title and address as they are now, and its alt says the same", async () => {
  const words = await cardWords();
  // The card is an image: nothing redraws it when the title or the site's address changes.
  assert.deepEqual(wordsDrawnOn(await readFile(CARD)), words, "run `node scripts/share-card.mjs` and commit the image");
  const { shareImage } = createRequire(import.meta.url)("../src/lib/site-url.ts");
  assert.equal(shareImage.alt, `${words.name} — ${words.line}`);
});
