"use client";

import { useEffect } from "react";

/**
 * The root layout declares `<html lang="en">` for every page; a page in another
 * language names its own while it is open and gives English back when it closes.
 */
export function DocumentLanguage({ lang }: { lang: string }) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.lang;
    root.lang = lang;
    return () => { root.lang = previous; };
  }, [lang]);
  return null;
}
