import { cn } from "@/lib/utils";

import { StatusChipBadge, type StatusChip } from "./workspace-shell-recovered";

export function identityStatusChips({ name, owner, machine, machineBusy, workspace }: {
  name?: string; owner?: string; machine?: string;
  /** How busy that Machine is now, toned behind its name. */
  machineBusy?: StatusChip["busy"];
  /** Already a tag, because only the caller knows a repository from a path. */
  workspace?: StatusChip;
}): StatusChip[] {
  // The label never renders now that the icon names the field; it is what the
  // tooltip says, so it reads like the Model and Effort tags next to it.
  const chips: StatusChip[] = [];
  if (name) chips.push({ id: "name", label: "Name", value: name });
  if (owner) chips.push({ id: "owner", label: "Owner", value: owner });
  if (machine) chips.push({ id: "machine", label: "Machine", value: machine, ...(machineBusy ? { busy: machineBusy } : {}) });
  if (workspace) chips.push(workspace);
  return chips;
}

/* Who, where, and in what. These answer which of two same-named Agents is
   speaking, so they stay whole and the tags after them give way first. */
export function AgentIdentityLabels({ name, owner, machine, machineBusy, workspace, wrap }: {
  name?: string; owner?: string; machine?: string; machineBusy?: StatusChip["busy"]; workspace?: StatusChip;
  /** Set where the cluster owns its own lines; a one-line header keeps them together. */
  wrap?: boolean;
}) {
  const chips = identityStatusChips({ name, owner, machine, machineBusy, workspace });
  if (!chips.length) return null;
  return <span className={cn(
    "app-agent-identity-labels inline-flex items-center gap-1",
    wrap ? "flex-wrap" : "shrink-0 flex-nowrap"
  )}>
    {chips.map((chip) => <StatusChipBadge key={chip.id} chip={chip} untruncated={!wrap} />)}
  </span>;
}
