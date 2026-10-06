"use client";

import { useState } from "react";

/**
 * Whose profile the Profile view is showing.
 *
 * Its own module rather than another field in the workspace shell state hook,
 * which is at the 5000-line source ceiling: adding to it is what pushes it
 * over. This is also where the state belongs — "which member am I looking at"
 * is answered entirely within one view and read by nothing else.
 *
 * `null` means the viewer's own profile, which is also what a reload lands on:
 * the route is /app/<space>/profile with no member segment, so a colleague's
 * profile is a navigation rather than a link.
 */
export function useHumanProfileViewState() {
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  return { profileUserId, setProfileUserId };
}
