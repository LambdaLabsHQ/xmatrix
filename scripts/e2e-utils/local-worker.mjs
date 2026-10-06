/** Launch a local fixture Worker with bounded, quiet test-mode defaults. */
export async function startTestWorker(unstableDev, entry, options) {
  const worker = await unstableDev(entry, {
    local: true,
    logLevel: "error",
    experimental: { disableExperimentalWarning: true, testMode: true },
    ...options,
  });
  return { worker, hubUrl: `http://${worker.address}:${worker.port}` };
}
