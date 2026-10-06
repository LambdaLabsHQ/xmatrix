import { PostgresAppRepository, type AuthorityDatabase, type RegistrationRepositoryReader } from "@xmatrix/db";
import { spaceLaunchTargetRepositories, type AppConnectorEnv } from "./app-connectors";

/** The repositories Jev chooses among, from the same GitHub catalog completion
 * reads. It is information for a choice, not an authorization: with no
 * configured connection it offers none, and the launch path treats a failed
 * read the same way. Reads stay request-local. */
export function registrationRepositoryCatalog(env: AppConnectorEnv, database: AuthorityDatabase, spaceId: string,
  repositories = spaceLaunchTargetRepositories): RegistrationRepositoryReader {
  const reads = new Map<string, ReturnType<RegistrationRepositoryReader>>();
  return actorUserId => {
    const prior = reads.get(actorUserId);
    if (prior) return prior;
    const read = (async () => {
      const { connection } = await new PostgresAppRepository(database).getConnection({
        requestId: `registration-repos:${crypto.randomUUID()}`, connectionId: `${spaceId}:github`, actorUserId, allowMissing: true });
      if (!connection || connection.status !== "configured") return undefined;
      const repos = await repositories(env, { ...connection, status: "configured" });
      return { repositories: repos.map(repo => repo.value) };
    })();
    reads.set(actorUserId, read);
    return read;
  };
}
