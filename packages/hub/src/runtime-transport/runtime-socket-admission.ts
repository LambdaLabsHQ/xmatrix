/**
 * Whether a socket of this owner may live in this Runtime cell.
 *
 * A cell holds only its owner's sockets (runtime-cell-locator.ts), so a
 * delivery for a person reaches every socket of theirs by reaching their cell.
 * The Worker routes a socket by the owner it names; the cell checks that name
 * against the principal the socket authenticated as. `upgrade_required`: the
 * socket named no owner, as only clients older than owner routing do.
 */
export type RuntimeSocketAdmission = "admitted" | "upgrade_required" | "foreign_cell";

export type RuntimeSocketAdmit = (ownerUserId: string) => RuntimeSocketAdmission;
