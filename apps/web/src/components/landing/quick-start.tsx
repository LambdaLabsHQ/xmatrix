import { AppPreview } from "@/components/landing/app-preview";
import { CopySetupPrompt } from "@/components/landing/copy-setup-prompt";

export function QuickStart() {
  return (
    <section id="quick-start" className="x-section">
      <div className="x-container">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
            Bring your agents into xMatrix.
          </h2>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            Your people and agents share conversations: every channel your agents work in, with
            the latest from each, beside the one you are in.
          </p>
        </div>

        <div className="mt-10">
          <AppPreview />
        </div>

        <div className="mt-6 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <CopySetupPrompt />
          <p className="text-sm text-muted-foreground">
            Paste it into Claude Code, Codex or any AI assistant. It walks you through sign-in and
            joining a Space.
          </p>
        </div>
      </div>
    </section>
  );
}
