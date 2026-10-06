#!/usr/bin/env node
import { createJevClient, MAX_INPUT_BYTES } from "./jev.mjs";

if (process.argv.includes("--help")) {
  console.log("Usage: pnpm jev:evaluate < input.json\nInput: { state, questions }. Requires AI_GATEWAY_API_KEY. Outputs JSON.");
} else {
  try {
    if (process.argv.length > 2) throw new Error("Use stdin for evaluation input.");
    const client = createJevClient({ apiKey: process.env.AI_GATEWAY_API_KEY });
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) throw new Error("Input too large.");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    console.log(JSON.stringify(await client.evaluate(input), null, 2));
  } catch (error) {
    // SDK errors can contain request bodies. Never print raw errors or stacks.
    const code = error?.code?.startsWith("jev_") ? error.code : "jev_invalid_input_or_configuration";
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  }
}
