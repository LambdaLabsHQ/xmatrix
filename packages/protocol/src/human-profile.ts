/**
 * What one Human looks like to everyone else.
 *
 * This is the single declaration of the public projection. Relay authority emits
 * exactly this shape and clients read exactly this shape — there is no
 * server-side variant with different field names. That is not a style
 * preference: an earlier identity contract in this repo had Authority speaking
 * `profileId`/`ownerUserId` while clients read `id`/`userId`, a test fixture
 * quietly normalized between them, and a broken route survived for months
 * behind the fixture. One shape, read by both sides, is what makes that class
 * of drift impossible rather than merely unlikely.
 *
 * The visibility boundary is expressed by what this type does NOT have. There
 * is no `email`, no sign-in method, no session or security state. Those belong
 * to the Auth Account and never travel in a Profile, so a caller cannot leak
 * them by forgetting to strip a field — the field is not there to forget.
 *
 * Membership facts (role, joinedAt) are deliberately absent too: they are
 * per-Space and belong to the membership record. A Human is one identity
 * across every Space, and folding a Space-scoped fact into it would make the
 * same person serialize differently depending on where they were read from.
 */
export interface HumanProfile {
  /** Stable actor identity, always the `user:<id>` form used for authorship. */
  identityId: string;
  userId: string;
  /** Free Unicode; what a reader sees. May be shared with other people. */
  displayName: string;
  /**
   * The stable `@` address, already canonical (lowercase). Absent only for an
   * account the backfill has not reached yet — during that window a client
   * shows the display name alone rather than inventing an address.
   */
  handle?: string;
  avatarUrl?: string;
  bio?: string;
  /**
   * The IANA zone this person reads time in, e.g. `Asia/Shanghai`.
   *
   * Here rather than in a client-side guess because the zone a timestamp was
   * rendered in is not recoverable from the rendered string: once "4:23 AM" is
   * screenshotted or quoted into a channel, only a stored zone can say whose
   * 4:23 it was. It is also what lets a reader tell a silence at someone's
   * three in the afternoon from one at their three in the morning.
   *
   * Absent for an account whose client has not reported one yet. A reader that
   * finds it missing renders in its own zone and says so, rather than assuming
   * the two agree.
   */
  timeZone?: string;
  /**
   * True while the handle is one the system generated rather than one the
   * person chose. Clients surface it as a gentle prompt to finish setting up,
   * never as an error, and never as a reason to block anything.
   */
  handleIsTemporary?: boolean;
  /**
   * Monotonic per-profile revision. Relay authority holds a copy of these fields and
   * cannot share a transaction with the account database, so this is what makes
   * the sync converge: a higher version wins, a lower one is ignored, and a
   * retried or reordered delivery is therefore harmless.
   */
  profileVersion: number;
}

/**
 * The fields a person may edit about themselves.
 *
 * Separate from `HumanProfile` because the readable set and the writable set
 * are genuinely different: `profileVersion` is server-owned, `identityId` is
 * not a preference, and `handleIsTemporary` is a consequence rather than a
 * choice. An update route that accepted `HumanProfile` wholesale would be
 * accepting three fields it must never take from a client.
 */
export interface HumanProfileEdit {
  displayName?: string;
  handle?: string;
  avatarUrl?: string;
  bio?: string;
  /**
   * Writable because a person may be somewhere their device is not, but not
   * something a client should make anyone choose: clients detect the zone and
   * send it when it differs from the stored one.
   */
  timeZone?: string;
}
