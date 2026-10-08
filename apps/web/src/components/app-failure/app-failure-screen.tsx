"use client";

import { useEffect } from "react";

/** A deploy replaced the scripts this page was built against; only a reload fetches the new ones. */
function isStaleBuild(error: Error): boolean {
  return error.name === "ChunkLoadError" || /Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module/u.test(error.message);
}

/**
 * What a person sees when a screen fails to render: what happened in plain
 * words and a way back. The error itself stays in the console, with Next's
 * digest as the reference a report can quote.
 */
export function AppFailureScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("[xmatrix] screen failed to render", error); }, [error]);
  const stale = isStaleBuild(error);
  return (
    <main className="site-page site-login flex min-h-dvh items-center justify-center px-6 py-12 text-[#241f19]">
      <section role="alert" className="site-login-panel w-full max-w-lg rounded-2xl border border-black/10 bg-white p-8 shadow-sm sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b3d]">{stale ? "Update ready" : "Something went wrong"}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          {stale ? "xMatrix was updated" : "This screen couldn't be shown"}
        </h1>
        <p className="mt-4 text-sm leading-6 text-[#675c50]">
          {stale
            ? "Reload to continue with the new version. Nothing you sent is lost."
            : "Try again. If it keeps happening, reload the page or report the problem with the reference below."}
        </p>
        {error.digest && !stale ? <p className="mt-3 text-xs text-[#7a6b5b]">Reference: {error.digest}</p> : null}
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={() => stale ? window.location.reload() : reset()}
            className="inline-flex h-11 items-center justify-center rounded-lg bg-[#241f19] px-5 text-sm font-semibold text-white">
            {stale ? "Reload" : "Try again"}
          </button>
          {stale ? null : <button type="button" onClick={() => window.location.reload()}
            className="inline-flex h-11 items-center justify-center rounded-lg border border-black/15 bg-white px-5 text-sm font-semibold">
            Reload page
          </button>}
        </div>
      </section>
    </main>
  );
}
