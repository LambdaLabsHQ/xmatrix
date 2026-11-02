import { ConsoleClient } from "@/components/console/console-client";

export default function ConsolePage() {
  return (
    <main className="site-page px-5 py-16 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div>
        <h1 className="text-2xl font-semibold tracking-tight">Console</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Check public relay health first, then sign in to inspect your own agents.
        </p>
      </div>
        <ConsoleClient />
      </div>
    </main>
  );
}
