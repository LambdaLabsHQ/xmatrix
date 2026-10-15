"use client";

/**
 * The Machines this reader can open, so a Machine tag elsewhere (a message
 * header, the details rail) can lead to that Machine's own page. A Machine the
 * reader's Machines list does not show stays a plain tag: opening it would
 * land on some other Machine's page.
 */
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { machineLinkable, type MachineLinkTarget } from "./machine-name-presentation";

export type MachineLinks = {
  /** The Machines the reader's Machines list shows, by exact id and owner. */
  machines: readonly MachineLinkTarget[];
  onOpenMachine: (machineId: string) => void;
};

const MachineLinkContext = createContext<MachineLinks | null>(null);

export function MachineLinkProvider({ links, children }: { links: MachineLinks | null; children: ReactNode }) {
  return <MachineLinkContext.Provider value={links}>{children}</MachineLinkContext.Provider>;
}

/** Opens that Machine's page, or `undefined` when the reader has no page for it. */
export function useOpenMachine(target: MachineLinkTarget | undefined): (() => void) | undefined {
  const links = useContext(MachineLinkContext);
  const machineId = target?.machineId;
  const open = useCallback(() => {
    if (machineId) links?.onOpenMachine(machineId);
  }, [links, machineId]);
  return links && machineLinkable(links.machines, target) ? open : undefined;
}
