/**
 * Where each app destination keeps its selection in the address
 * (`/app/<space>/settings?section=billing`). The views read their selection
 * from this field, and every address that opens one is built from it: the
 * shell's own navigation, `/billing`, provider returns and the Hub's redirects.
 *
 * Callers used to write the field by hand. When the shared `item` field was
 * retired, `/billing` kept writing it, and Stripe Checkout returned people to
 * Settings › Account instead of Billing. A caller names the view and what to
 * select; only this table names the field.
 */
export const APP_VIEW_SELECTION_FIELDS = {
  apps: "connector",
  agents: "agent",
  machines: "machine",
  local: "machine",
  automation: "schedule",
  settings: "section",
  admin: "section",
  team: "space",
} as const;

export type AppSelectionView = keyof typeof APP_VIEW_SELECTION_FIELDS;

/** Whether `view` keeps a selection in the address. */
export function isAppSelectionView(view: string): view is AppSelectionView {
  return Object.hasOwn(APP_VIEW_SELECTION_FIELDS, view);
}

/** The selection field `view` reads, or null when the view has none. */
export function appViewSelectionField(view: string): string | null {
  return isAppSelectionView(view) ? APP_VIEW_SELECTION_FIELDS[view] : null;
}

/**
 * The query that opens `selection` in `view`, then any `extra` fields that
 * view also reads (a provider's return, `edit=profile`). `base` keeps fields
 * already in hand, such as the return parameters `/billing` forwards.
 */
export function appViewSelectionQuery(
  view: AppSelectionView,
  selection: string,
  extra: Readonly<Record<string, string>> = {},
  base?: URLSearchParams,
): URLSearchParams {
  const selectionField = APP_VIEW_SELECTION_FIELDS[view];
  const query = new URLSearchParams({ [selectionField]: selection });
  for (const [field, value] of base ?? []) if (field !== selectionField) query.append(field, value);
  for (const [field, value] of Object.entries(extra)) query.set(field, value);
  return query;
}

/** `/app/<space>/<view>` opened on `selection`, for links built outside the app shell. */
export function appViewAddress(
  spaceId: string,
  view: AppSelectionView,
  selection: string,
  extra?: Readonly<Record<string, string>>,
): string {
  return `/app/${encodeURIComponent(spaceId)}/${view}?${appViewSelectionQuery(view, selection, extra)}`;
}
