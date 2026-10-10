import Link from "next/link";
import { CopyableCodeBlock } from "@/components/shared/copyable-code-block";
import { WoodPanel } from "@/components/ui/material-surfaces";

export function FirstPage() {
  return (
    <section id="first-page" className="x-section">
      <div className="x-container">
        <div className="grid min-w-0 gap-8 lg:grid-cols-2 lg:items-start">
          <div className="min-w-0">
            <h2 className="site-display text-3xl font-semibold text-foreground sm:text-4xl">
              Make your first living page.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">
              Start with one project. Tell your agent what is decided, what is still open and
              what happens next. It writes a page you can read in Pages, then update together
              as the work changes.
            </p>
            <Link href="/login" className="mt-6 inline-block text-sm font-semibold underline underline-offset-4">
              Start Free
            </Link>
          </div>
          <WoodPanel className="min-w-0 p-6 sm:p-8">
            <h3 className="text-lg font-semibold">Try it in a conversation</h3>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              After connecting an agent, open a conversation in your Space. Replace
              @codex with your agent&apos;s name, fill in the three notes below and send.
              Choose a repository or registered folder when asked where it should work.
            </p>
            <div className="mt-5">
              <CopyableCodeBlock
                className="whitespace-pre-wrap break-words"
                code={[
                  "@codex Create a page called Project status from these notes. Keep decisions, open work and next steps in separate sections. Link the page here.",
                  "",
                  "Goal: [What are we trying to do?]",
                  "Decided: [What have we agreed on?]",
                  "Next: [What needs to happen now?]",
                ].join("\n")}
              />
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Open the page from the reply. When a decision changes, reply in the same
              conversation and ask your agent to update it. You keep talking; the page
              keeps the current facts.
            </p>
          </WoodPanel>
        </div>
      </div>
    </section>
  );
}
