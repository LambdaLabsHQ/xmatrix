import { plainRecord as record } from "./plain-record.js";
import { hasControlCharacter, replaceControlCharacters } from "./field-validation.js";

/** Upstream recipes are documentation data. Executing one requires owner approval. */
export interface HarnessCommand {
  command: string;
  args: string[];
}

export interface HarnessAutoUpdate {
  behavior: "automatic" | "notify" | "manual" | "unknown" | "unsupported";
  defaultEnabled?: boolean;
  controls: Array<
    | { kind: "env"; key: string; enabled: string | null; disabled: string }
    | { kind: "json" | "toml"; path: string; key: string; enabled: boolean; disabled: boolean }
    | { kind: "command"; enable: HarnessCommand; disable: HarnessCommand }
    | { kind: "flag"; disabled: string }
  >;
  /** Upstream conditions that turn the built-in updater off; read only to observe its state. */
  disabledBy?: Array<
    | { kind: "env"; key: string; values?: string[] }
    | { kind: "json"; path: string; key: string; value: unknown; unless?: Record<string, unknown> }
  >;
  /** JSON settings files whose `env` object the harness applies to its own environment. */
  envFiles?: string[];
  /**
   * The built-in updater runs only in interactive sessions, never in the
   * headless mode xMatrix launches; the daemon runs `update` in its place.
   */
  interactiveOnly?: boolean;
  notes?: string;
}

/**
 * The harness's own official sign-in, run by the daemon without a terminal.
 * `device_code` prints a URL and a one-time code to enter there; `url_paste_code`
 * prints a URL and reads the code the sign-in page shows back on stdin.
 * Capture group 1 of `urlRegex`/`codeRegex` over the output, controls removed.
 */
export interface HarnessLogin {
  flow: "device_code" | "url_paste_code";
  start: HarnessCommand & { env?: Record<string, string> };
  urlRegex: string;
  codeRegex?: string;
  /** Exit status 0 means signed in, unless `signedInRegex` must also match its output. */
  status?: HarnessCommand & { signedInRegex?: string };
  notes?: string;
}

export interface HarnessManagement {
  /** null means no verified CLI version command. Capture group 1 is the version. */
  version: (HarnessCommand & { regex: string }) | null;
  /** null means no verified native recipe for that platform. */
  install: { unix: HarnessCommand | null; windows: HarnessCommand | null };
  update: { unix: HarnessCommand | null; windows: HarnessCommand | null };
  /** Removes the program and keeps the user's settings and sessions. */
  uninstall: { unix: HarnessCommand | null; windows: HarnessCommand | null };
  autoUpdate: HarnessAutoUpdate;
  /** Absent means no official sign-in the daemon can drive remotely. */
  login?: HarnessLogin;
  /** Official registry that publishes this harness; absent means its latest version is not knowable. */
  latest?: { kind: "npm" | "pypi"; package: string };
  sources: string[];
  checkedAt: string;
  notes?: string;
}

export interface HarnessInventoryItem {
  id: string;
  installed: boolean;
  path?: string;
  version?: string;
  probeStatus: "ok" | "missing" | "unsupported" | "timeout" | "failed" | "unrecognized";
  /** Newest version on the harness's official registry, when it publishes to one. */
  latestVersion?: string;
  /** Effective automatic updating on this machine: native control or the daemon's own update. */
  autoUpdate?: "enabled" | "disabled" | "unknown";
  /** The harness's own sign-in status, when its preset has a status command. */
  login?: HarnessLoginState;
}

export const HARNESS_LOGIN_STATES = ["signed_in", "signed_out", "unknown"] as const;
export type HarnessLoginState = typeof HARNESS_LOGIN_STATES[number];

/** Observations only: never registration, admission, or update authorization. */
export interface HarnessInventory {
  schemaVersion: 1;
  capturedAt: string;
  items: HarnessInventoryItem[];
}

const AUTO_UPDATE_STATES = new Set(["enabled", "disabled", "unknown"]);
const STATUSES = new Set(["ok", "missing", "unsupported", "timeout", "failed", "unrecognized"]);
const ID = /^[a-z][a-z0-9-]{0,63}$/u;

/** Fail closed, strip unknown keys, and keep daemon output out of persisted metadata. */
export function parseHarnessInventory(value: unknown): HarnessInventory | undefined {
  const input = record(value);
  if (!input || input.schemaVersion !== 1 || typeof input.capturedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(input.capturedAt) ||
      !Number.isFinite(Date.parse(input.capturedAt)) ||
      !Array.isArray(input.items) || input.items.length > 64) return undefined;
  const ids = new Set<string>();
  const items: HarnessInventoryItem[] = [];
  for (const value of input.items) {
    const item = record(value);
    if (!item || typeof item.id !== "string" || !ID.test(item.id) || ids.has(item.id) ||
        typeof item.installed !== "boolean" || typeof item.probeStatus !== "string" ||
        !STATUSES.has(item.probeStatus)) return undefined;
    if (item.autoUpdate !== undefined && !AUTO_UPDATE_STATES.has(item.autoUpdate as string)) return undefined;
    if (item.login !== undefined && !(HARNESS_LOGIN_STATES as readonly unknown[]).includes(item.login)) return undefined;
    for (const [key, max] of [["path", 4096], ["version", 128], ["latestVersion", 128]] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "string" ||
          item[key].length === 0 || item[key].length > max || hasControlCharacter(item[key]))) return undefined;
    }
    if (!item.installed && (item.path !== undefined || item.version !== undefined) ||
        item.probeStatus === "ok" && (!item.installed || item.version === undefined) ||
        item.probeStatus === "missing" && item.installed) return undefined;
    ids.add(item.id);
    items.push({ id: item.id, installed: item.installed,
      probeStatus: item.probeStatus as HarnessInventoryItem["probeStatus"],
      ...(item.path === undefined ? {} : { path: item.path as string }),
      ...(item.version === undefined ? {} : { version: item.version as string }),
      ...(item.latestVersion === undefined ? {} : { latestVersion: item.latestVersion as string }),
      ...(item.autoUpdate === undefined ? {} : { autoUpdate: item.autoUpdate as HarnessInventoryItem["autoUpdate"] }),
      ...(item.login === undefined ? {} : { login: item.login as HarnessLoginState }),
    });
  }
  const inventory: HarnessInventory = { schemaVersion: 1, capturedAt: input.capturedAt, items };
  return JSON.stringify(inventory).length <= 24 * 1024 ? inventory : undefined;
}

/**
 * Owner-requested work on one harness. A command names only the preset and the
 * action; the daemon runs the recipe compiled into it, never one sent to it.
 * `refresh` re-probes every preset and ignores `presetId`'s recipe.
 * `release` says the preset's official registry published a version this
 * machine has not seen: the daemon reads the registry itself and applies its
 * automatic-update policy.
 * `login_start` runs the preset's official sign-in and answers with its URL and
 * code; `login_finish` hands it the code the owner pasted (for `url_paste_code`)
 * and waits for it to finish; `login_cancel` ends it.
 */
export const HARNESS_ACTIONS = ["install", "update", "uninstall", "auto_update_on", "auto_update_off", "refresh", "release",
  "login_start", "login_finish", "login_cancel"] as const;
export type HarnessAction = typeof HARNESS_ACTIONS[number];
export const MACHINE_HARNESS_ACTION_CAPABILITY = "machine_harness_action_v1";
/** Cursor updates must bind the vendor launcher, never an unrelated `agent` on PATH. */
export const MACHINE_HARNESS_CURSOR_LAUNCHER_CAPABILITY = "machine_harness_cursor_launcher_v1";
/** A daemon without it cannot parse an `uninstall` command, so none is issued or leased to it. */
export const MACHINE_HARNESS_UNINSTALL_CAPABILITY = "machine_harness_uninstall_v1";
/** A daemon without it cannot parse a `release` command, so none is issued or leased to it. */
export const MACHINE_HARNESS_RELEASE_CAPABILITY = "machine_harness_release_v1";
/** A daemon without it cannot parse a `login_*` command, so none is issued or leased to it. */
export const MACHINE_HARNESS_LOGIN_CAPABILITY = "machine_harness_login_v1";
export const HARNESS_LOGIN_ACTIONS: readonly HarnessAction[] = ["login_start", "login_finish", "login_cancel"];
const LOGIN_CODE_MAX = 2_048;
const LOGIN_URL_MAX = 2_048;
const LOGIN_USER_CODE_MAX = 64;
const OUTPUT_TAIL_MAX = 4 * 1024;

export interface HarnessActionRequest {
  requestId: string;
  presetId: string;
  action: HarnessAction;
  /** Only on `login_finish`: the code the sign-in page showed the owner. */
  code?: string;
}

/** Where a sign-in stands after a `login_*` action. */
export interface HarnessLoginProgress {
  state: "awaiting_user" | "signed_in" | "failed" | "cancelled";
  flow?: HarnessLogin["flow"];
  /** Open this to sign in. Only for `awaiting_user`. */
  verificationUri?: string;
  /** Enter this there, for `device_code`. */
  userCode?: string;
}

export interface HarnessActionResult {
  presetId: string;
  action: HarnessAction;
  status: "succeeded" | "failed" | "unsupported";
  exitCode?: number;
  /** Last bytes of combined output, control characters removed. */
  outputTail?: string;
  /** The preset re-probed after the action. */
  item?: HarnessInventoryItem;
  /** Every preset re-probed, for `refresh`. */
  inventory?: HarnessInventory;
  login?: HarnessLoginProgress;
}

/** What the owner's status read returns; `error` is a bounded, user-facing message. */
export interface HarnessActionStatus {
  controlId: string;
  presetId: string;
  action: HarnessAction;
  status: "queued" | "running" | "succeeded" | "failed" | "unsupported" | "expired";
  result?: HarnessActionResult;
  error?: string;
  completedAt?: string;
}

function isHarnessAction(value: unknown): value is HarnessAction {
  return typeof value === "string" && (HARNESS_ACTIONS as readonly string[]).includes(value);
}

/** A pasted sign-in code: one printable line. */
export function validHarnessLoginCode(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= LOGIN_CODE_MAX &&
    !hasControlCharacter(value);
}

export function parseHarnessActionRequest(value: unknown): HarnessActionRequest {
  const input = record(value);
  if (!input || typeof input.requestId !== "string" || !/^harness:[0-9a-f-]{36}$/u.test(input.requestId) ||
      typeof input.presetId !== "string" || !ID.test(input.presetId) || !isHarnessAction(input.action) ||
      (input.code !== undefined && (input.action !== "login_finish" || !validHarnessLoginCode(input.code)))) {
    throw new Error("Invalid harness action request");
  }
  return { requestId: input.requestId, presetId: input.presetId, action: input.action,
    ...(input.code === undefined ? {} : { code: input.code as string }) };
}

function parseLoginProgress(value: unknown, action: HarnessAction): HarnessLoginProgress {
  const input = record(value);
  const state = input?.state;
  if (!input || !HARNESS_LOGIN_ACTIONS.includes(action) ||
      !["awaiting_user", "signed_in", "failed", "cancelled"].includes(state as string) ||
      (input.flow !== undefined && input.flow !== "device_code" && input.flow !== "url_paste_code")) {
    throw new Error("Harness login progress is invalid");
  }
  const uri = input.verificationUri;
  if (uri !== undefined && (state !== "awaiting_user" || typeof uri !== "string" || uri.length > LOGIN_URL_MAX ||
      hasControlCharacter(uri) || !/^https:\/\/[^\s]+$/u.test(uri))) throw new Error("Harness login URL is invalid");
  const code = input.userCode;
  if (code !== undefined && (state !== "awaiting_user" || typeof code !== "string" || code.length === 0 ||
      code.length > LOGIN_USER_CODE_MAX || hasControlCharacter(code))) throw new Error("Harness login code is invalid");
  if (state === "awaiting_user" && uri === undefined) throw new Error("Harness login is missing its URL");
  return { state: state as HarnessLoginProgress["state"],
    ...(input.flow === undefined ? {} : { flow: input.flow as HarnessLogin["flow"] }),
    ...(uri === undefined ? {} : { verificationUri: uri }),
    ...(code === undefined ? {} : { userCode: code }) };
}

/** Bounded tail of process output with control characters (except newline and tab) removed. */
export function harnessOutputTail(value: string): string {
  const cleaned = replaceControlCharacters(value, "", "\t\n");
  return cleaned.length > OUTPUT_TAIL_MAX ? cleaned.slice(cleaned.length - OUTPUT_TAIL_MAX) : cleaned;
}

/** Fail closed: a result must answer exactly the issued request. */
export function parseHarnessActionResult(value: unknown, issued: HarnessActionRequest): HarnessActionResult {
  const input = record(value);
  if (!input || input.presetId !== issued.presetId || input.action !== issued.action ||
      !["succeeded", "failed", "unsupported"].includes(input.status as string) ||
      (input.exitCode !== undefined && !Number.isSafeInteger(input.exitCode)) ||
      (input.outputTail !== undefined && (typeof input.outputTail !== "string" || input.outputTail.length > OUTPUT_TAIL_MAX))) {
    throw new Error("Harness action result differs from the issued request");
  }
  let item: HarnessInventoryItem | undefined;
  if (input.item !== undefined) {
    const parsed = parseHarnessInventory({ schemaVersion: 1, capturedAt: new Date(0).toISOString().replace(".000", ""), items: [input.item] });
    item = parsed?.items[0];
    if (!item || item.id !== issued.presetId) throw new Error("Harness action result item is invalid");
  }
  let inventory: HarnessInventory | undefined;
  if (input.inventory !== undefined) {
    inventory = parseHarnessInventory(input.inventory);
    if (!inventory || issued.action !== "refresh") throw new Error("Harness action result inventory is invalid");
  }
  const login = input.login === undefined ? undefined : parseLoginProgress(input.login, issued.action);
  return { presetId: issued.presetId, action: issued.action, status: input.status as HarnessActionResult["status"],
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode as number }),
    ...(input.outputTail === undefined ? {} : { outputTail: harnessOutputTail(input.outputTail as string) }),
    ...(item ? { item } : {}), ...(inventory ? { inventory } : {}), ...(login ? { login } : {}) };
}

/**
 * Whether a preset has any official recipe for the action on some platform.
 * Automatic updating is available through a native control, or through xMatrix
 * running the update recipe on a schedule when the harness has no updater.
 */
export function harnessActionAvailable(management: HarnessManagement | undefined, action: HarnessAction): boolean {
  if (!management) return false;
  const any = (recipe: { unix: HarnessCommand | null; windows: HarnessCommand | null }) =>
    recipe.unix !== null || recipe.windows !== null;
  switch (action) {
    case "refresh": return true;
    case "release": return management.latest !== undefined;
    case "install": return any(management.install);
    case "update": return any(management.update);
    case "uninstall": return any(management.uninstall);
    case "login_start":
    case "login_finish":
    case "login_cancel":
      return management.login !== undefined;
    case "auto_update_on":
    case "auto_update_off":
      return management.autoUpdate.controls.length > 0 ||
        (["notify", "manual", "unknown"].includes(management.autoUpdate.behavior) && any(management.update));
  }
}
