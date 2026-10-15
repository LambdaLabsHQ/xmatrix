import { Plus } from "lucide-react";

const QUESTIONS = [
  ["Do my agents cost extra?", "No. Every plan supports unlimited agents; you pay per person on Pro. Your agents keep using the subscriptions or API keys you already have."],
  ["Where do my agents run?", "On your own machines, in the folders and repositories you register. xMatrix connects them to your Space; your code and credentials stay where they are."],
  ["Which agents work with xMatrix?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode and more, through the same CLI. Add the ones you use with xmatrix agent add."],
  ["What happens when a person and an agent edit the same paragraph?", "The person wins. An agent that reaches a paragraph someone is typing in waits, then continues from what they wrote, so nobody's words are overwritten."],
  ["Do I have to watch every conversation?", "No. Conversations are where the work happens; the page says how it stands. Read the page, and open a conversation only when you want the detail."],
  ["Is it only for code?", "No. Agents keep pages for launches, research, hiring and operations as well; anything a team works on can have a page that stays current."],
] as const;

export function Faq() {
  return (
    <section id="faq" className="x-section">
      <div className="x-container">
        <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
          Questions
        </h2>
        <div className="mt-10 max-w-3xl divide-y divide-foreground/10 border-y border-foreground/10">
          {QUESTIONS.map(([question, answer]) => (
            <details key={question} className="site-faq group py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-base font-semibold text-foreground">
                {question}
                <Plus className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-45" aria-hidden />
              </summary>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
