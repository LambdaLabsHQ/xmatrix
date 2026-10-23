"use client";

import { createContext, useContext } from "react";

/** What the welcome's cards ask the shell to do: things only the shell can open. */
export interface OnboardingActions {
  /** Opens New conversation, its composer holding `draft` for the person to send. */
  startConversation: (draft: string) => void;
  /** Opens Machines, where another computer is connected. */
  connectAnotherComputer: () => void;
}

export const OnboardingActionsContext = createContext<OnboardingActions | null>(null);

export function useOnboardingActions(): OnboardingActions | null {
  return useContext(OnboardingActionsContext);
}
