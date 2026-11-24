import { AppWindow } from "@/components/landing/app-window";
import { StageCaption } from "@/components/landing/section-intro";
import { landingCopy, type Locale } from "@/lib/landing-copy";

/** Behind the page: the app itself, with a conversation where a person and two Agents work. */
export function Conversations({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].conversations;
  return (
    <section id="conversations" className="x-section" aria-labelledby="conversations-title">
      <div className="x-container">
        <StageCaption id="conversations-title" title={copy.title} body={copy.body} />
        <AppWindow />
      </div>
    </section>
  );
}
