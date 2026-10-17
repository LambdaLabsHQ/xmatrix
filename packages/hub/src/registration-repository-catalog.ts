import { AppControlError, PostgresAppRepository, type AuthorityDatabase, type RegistrationRepositoryReader } from "@xmatrix/db";
import { spaceLaunchTargetRepositories, type AppConnectorEnv } from "./app-connectors";
import { utf8ByteLength } from "@xmatrix/protocol";

/** Bound each project's contribution to Jev's 64 KiB request, including JSON
 * escapes and multibyte text, without splitting a Unicode character. */
function decisionDescription(value: string | undefined): string {
  let description = "";
  for (const character of value?.trim() ?? "") {
    if (utf8ByteLength(JSON.stringify(description + character)) > 256) break;
    description += character;
  }
  return description;
}

/** The repositories Jev chooses among, from the same GitHub catalog completion
 * reads. It is information for a choice, not an authorization: with no
 * configured connection it offers none, nor to a viewer or participant, who
 * do not use the Space's connections; the launch path treats a failed read the
 * same way. Reads stay request-local. */
export function registrationRepositoryCatalog(env: AppConnectorEnv, database: AuthorityDatabase, spaceId: string,
  repositories = spaceLaunchTargetRepositories): RegistrationRepositoryReader {
  const reads = new Map<string, ReturnType<RegistrationRepositoryReader>>();
  return actorUserId => {
    const prior = reads.get(actorUserId);
    if (prior) return prior;
    const read = (async () => {
      const read = await new PostgresAppRepository(database).getConnection({
        requestId: `registration-repos:${crypto.randomUUID()}`, connectionId: `${spaceId}:github`, actorUserId,
        use: true, allowMissing: true }).catch((error: unknown) => {
        if (error instanceof AppControlError && error.code === "space_not_found") return undefined;
        throw error;
      });
      const connection = read?.connection;
      if (!connection || connection.status !== "configured") return undefined;
      const repos = await repositories(env, { ...connection, status: "configured" });
      return { repositories: repos.map(repo => repo.value),
        descriptions: Object.fromEntries(repos.flatMap(repo => {
          const description = decisionDescription(repo.description);
          return description ? [[repo.value, description]] : [];
        })) };
    })();
    reads.set(actorUserId, read);
    return read;
  };
}
