"use client";

import { ArrowUpRight, CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import type { EventCard as EventCardData } from "@xmatrix/protocol";
import { useOnboardingLocale } from "@/lib/onboarding-locale";

const ICON = { good: CircleCheck, bad: CircleAlert, plain: CircleDot };

/* An App event (a payment, a canceled subscription) as a slip of the paper:
   what happened and its figure on the first line, why under it, then the
   small facts that tell it from the next one and the way to its page at the
   App. It reads in the reader's own language; the message body under it stays
   what Agents and search read. */
export function EventCard({ card, spaceId, token, userId }: {
  card: EventCardData; spaceId: string | null; token: string | null; userId: string;
}) {
  const locale = useOnboardingLocale(spaceId, token, userId);
  const Icon = ICON[card.tone];
  return (
    <section className="app-paper-card app-event-card mt-1.5 w-full max-w-md" data-testid="event-card" data-event-card={card.tone}
      role="group" aria-label={card.title[locale]}>
      <h3 className="flex items-baseline gap-2 text-[16px] font-extrabold leading-snug tracking-tight">
        <Icon className="app-event-card-icon size-[17px] shrink-0 translate-y-[3px]" aria-hidden="true" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{card.title[locale]}</span>
        {card.value ? <span className="shrink-0 tabular-nums">{card.value}</span> : null}
      </h3>
      {card.note ? <p className="mt-0.5 pl-[25px] text-[14px] leading-[1.5] [overflow-wrap:anywhere]">{card.note[locale]}</p> : null}
      <p className="mt-1 flex items-baseline gap-3 pl-[25px] text-[12.5px] leading-[1.5] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{card.meta.map(item => item[locale]).join(" · ")}</span>
        {card.link ? <a href={card.link.url} target="_blank" rel="noreferrer noopener"
          className="app-event-card-link inline-flex shrink-0 items-center gap-0.5 font-bold hover:text-foreground">
          {card.link.label[locale]}<ArrowUpRight className="size-3.5" aria-hidden="true" />
        </a> : null}
      </p>
    </section>
  );
}
