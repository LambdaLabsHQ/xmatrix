"use client";

import { useEffect, useState } from "react";

type Heading = { element: HTMLElement; text: string; level: number };

/**
 * The page's sections at the right edge, as Notion's published pages draw
 * them: one short rule per heading, the one in view darker. Hovering opens
 * their names; choosing one goes to it.
 */
export function PublicPageOutline() {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const found = [...document.querySelectorAll<HTMLElement>(".public-page-document :is(h2, h3)")]
      .map((element) => ({ element, text: element.textContent ?? "", level: element.tagName === "H3" ? 3 : 2 }));
    setHeadings(found);
    const onScroll = () => {
      let index = 0;
      found.forEach((heading, at) => { if (heading.element.getBoundingClientRect().top < window.innerHeight * 0.35) index = at; });
      setCurrent(index);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (headings.length < 2) return null;
  return (
    <nav className="public-page-outline" aria-label="Sections">
      {headings.map((heading, index) => (
        <button key={index} type="button" data-level={heading.level} data-current={index === current || undefined}
          onClick={() => heading.element.scrollIntoView({ behavior: "smooth", block: "start" })}>
          <span aria-hidden className="public-page-outline-rule" />
          <span className="public-page-outline-name">{heading.text}</span>
        </button>
      ))}
    </nav>
  );
}
