"use client";

import { useCallback, useState } from "react";

/**
 * Popovers opened from inside the app portal into the trigger's own
 * `.xmatrix-app` root, not `<body>`: the theme's surface variables and every
 * `.xmatrix-app`-scoped rule only reach elements under that root, so a popup
 * on `<body>` rendered unstyled in the default palette.
 */
export function useAppPortalContainer() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useCallback((element: HTMLElement | null) => {
    if (element) setContainer(element.closest<HTMLElement>(".xmatrix-app"));
  }, []);
  return { triggerRef, container: container ?? undefined };
}
