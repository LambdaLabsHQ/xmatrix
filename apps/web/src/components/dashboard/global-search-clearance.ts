"use client";

import { useLayoutEffect, useState } from "react";

/**
 * A header that runs under the window's search capsule (top right) ends its
 * controls before the capsule instead. Returns a ref callback for the header.
 */
export function useGlobalSearchClearance<T extends HTMLElement>(): (node: T | null) => void {
  const [node, setNode] = useState<T | null>(null);
  useLayoutEffect(() => {
    if (!node) return undefined;
    const update = () => {
      node.style.paddingRight = "";
      const search = document.querySelector(".app-global-search");
      if (!search) return;
      const capsule = search.getBoundingClientRect();
      const header = node.getBoundingClientRect();
      if (!capsule.width || header.bottom <= capsule.top || header.top >= capsule.bottom) return;
      const overlap = header.right - capsule.left;
      if (overlap > 0) node.style.paddingRight = `${overlap + 12}px`;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node.parentElement ?? node);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [node]);
  return setNode;
}
