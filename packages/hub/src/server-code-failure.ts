/** Keep uploaded Worker code locations, never an error's text, properties or cause. */
export function serverCodeFailure(error: unknown, name: string, message: string): Error {
  const failure = new Error(message);
  failure.name = name;
  const frames = error instanceof Error && typeof error.stack === "string"
    ? error.stack.split("\n").slice(1).filter(line =>
      /^\s+at (?:(?:async )?[A-Za-z_$][\w$.<>]{0,119} \()?(?:app:\/\/\/)?index\.js:[1-9]\d{0,8}:[1-9]\d{0,8}\)?$/u.test(line)
    ).slice(0, 32) : [];
  failure.stack = frames.length ? `${failure.name}: ${failure.message}\n${frames.join("\n")}` : undefined;
  return failure;
}
