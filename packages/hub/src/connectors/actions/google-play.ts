import { PACKAGE_NAME, play, playRequest } from "../google-play-api";
import { record, text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionStatement } from "../provider";
import { jsonFields } from "./app-store-connect";
import { GOOGLE_PLAY_OPERATION_ACTIONS, playOutput } from "./google-play-operations";

/*
 * The release loop that fastlane supply and Gradle Play Publisher run, as two
 * actions: read every track, and put version codes on a track and commit.
 * Bytes reach Google through api_upload; everything else stays in the catalog.
 */

const EDIT_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const RELEASE_FIELDS = ["track", "versionCodes", "status", "userFraction", "name", "releaseNotes", "inAppUpdatePriority", "changesNotSentForReview"];
type Credentials = Readonly<Record<string, string>>;

function app(statement: ConnectorActionStatement): { packageName: string; editId?: string } | undefined {
  const [packageName = "", editId, extra] = statement.target.split("/");
  if (!PACKAGE_NAME.test(packageName) || packageName.length > 150 || extra !== undefined || (editId !== undefined && !EDIT_ID.test(editId))) return undefined;
  return { packageName, ...(editId ? { editId } : {}) };
}

/** A temporary edit, always discarded: Google lists tracks only inside one. */
async function inEdit<T>(credentials: Credentials, packageName: string, use: (editId: string) => Promise<T>): Promise<T> {
  const editId = text((await play(credentials, "edits.insert", { path: { packageName }, body: {} })).id);
  if (!EDIT_ID.test(editId)) throw new ProviderRequestError(502, "Google Play did not open an edit");
  try { return await use(editId); }
  finally { await play(credentials, "edits.delete", { path: { packageName, editId } }).catch(() => undefined); }
}

function releaseRequest(statement: ConnectorActionStatement): Record<string, string> | string {
  const target = app(statement);
  const fields = jsonFields(statement.text.trim());
  if (!target || !fields) return 'use <package>[/<editId>] {"track":"internal","versionCodes":["42"],"status":"completed"}';
  if (Object.keys(fields).some(key => !RELEASE_FIELDS.includes(key))) return `options are ${RELEASE_FIELDS.join(", ")}`;
  if (typeof fields.track !== "string" || !Array.isArray(fields.versionCodes) ||
    fields.versionCodes.some(code => !/^[1-9]\d{0,9}$/u.test(String(code)))) return "track and versionCodes (positive integers) are required";
  if (fields.changesNotSentForReview !== undefined && typeof fields.changesNotSentForReview !== "boolean") return "changesNotSentForReview must be true or false";
  const { track, changesNotSentForReview, ...release } = fields;
  const body = { track, releases: [{ status: "completed", ...release, versionCodes: (fields.versionCodes as unknown[]).map(String) }] };
  try { playRequest("edits.tracks.update", { path: { packageName: target.packageName, editId: "e", track }, body }); }
  catch (error) { return error instanceof Error ? error.message : "invalid release"; }
  return { ...target, track, body: JSON.stringify(body), ...(changesNotSentForReview ? { changesNotSentForReview: "true" } : {}) };
}

export const GOOGLE_PLAY_ACTIONS: Record<string, ConnectorAction> = {
  ...GOOGLE_PLAY_OPERATION_ACTIONS,
  tracks: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => {
      const target = app(statement);
      return target && !target.editId && !statement.text.trim() ? target : "use @googleplay:tracks:<package name>";
    },
    async execute({ credentials }, input) {
      const tracks = await inEdit(credentials, input.packageName!, editId => play(credentials, "edits.tracks.list", { path: { packageName: input.packageName!, editId } }));
      const rows = (Array.isArray(tracks.tracks) ? tracks.tracks : []).map(record).map(track => ({ track: track.track,
        releases: (Array.isArray(track.releases) ? track.releases : []).map(record).map(release => ({ name: release.name, status: release.status,
          versionCodes: release.versionCodes, ...(release.userFraction === undefined ? {} : { userFraction: release.userFraction }) })) }));
      return { summary: `${input.packageName} tracks (read in a temporary edit, then discarded):\n${playOutput(rows)}` };
    },
  },
  release: {
    effect: "write", requires: ["oauthToken"], parse: releaseRequest,
    async execute(context, input) {
      const { credentials } = context, packageName = input.packageName!;
      await context.authorizeWrite?.();
      const opened = !input.editId;
      const editId = input.editId ?? text((await play(credentials, "edits.insert", { path: { packageName }, body: {} })).id);
      if (!EDIT_ID.test(editId)) throw new ProviderRequestError(502, "Google Play did not open an edit");
      try {
        const track = await play(credentials, "edits.tracks.update", { path: { packageName, editId, track: input.track! }, body: JSON.parse(input.body!) });
        const committed = await play(credentials, "edits.commit", { path: { packageName, editId },
          ...(input.changesNotSentForReview ? { query: { changesNotSentForReview: true } } : {}) });
        return { summary: `Google Play committed edit ${text(committed.id) || editId}: ${input.track} now has\n${playOutput(track.releases)}\nRun tracks to see the published state.` };
      } catch (error) {
        // An edit this action opened is discarded on failure; a caller's edit stays for them to inspect.
        if (opened) await play(credentials, "edits.delete", { path: { packageName, editId } }).catch(() => undefined);
        throw error;
      }
    },
  },
};
