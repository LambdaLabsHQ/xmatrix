import { githubRepositoryReference, type RegistrationResourceLimits } from "@xmatrix/protocol";

/** The repositories Jev may choose among. It is information for a choice, not
 * an authorization: a `repo:` launch is passed to the runtime as the repository
 * to work in, and the Space's GitHub installation token is the only gate on
 * cloning, pushing or opening a pull request there. */
export interface RegistrationRepositoryCatalog {
  repositories: string[];
}
export type RegistrationRepositoryReader = (actorUserId: string) => Promise<RegistrationRepositoryCatalog | undefined>;

/** `repo:owner/name`, bare `owner/name`, and a GitHub URL name the same repository. */
export function registrationRepository(reference: string | undefined): string | undefined {
  if (!reference) return undefined;
  const github = githubRepositoryReference(reference.startsWith("repo:") ? reference.slice("repo:".length) : reference);
  return github ? `${github.owner}/${github.repo}` : undefined;
}

/** A repository is not a machine-local directory grant: a single `repo:`
 * workspace passes through without being listed in the owner's grant. */
export function registrationResourcesWithinOwnerScope(requested: RegistrationResourceLimits): RegistrationResourceLimits {
  const repository = requested.workspaces.length === 1 ? registrationRepository(requested.workspaces[0]) : undefined;
  return repository ? { ...requested, workspaces: [] } : requested;
}

/** Jev chooses among at most this many catalog repositories, most recently
 * active first. */
const REGISTRATION_REPOSITORY_CHOICE_LIMIT = 100;

function repositoryCatalogForSummon(catalog: RegistrationRepositoryCatalog | undefined):
  RegistrationRepositoryCatalog | undefined {
  return catalog && { repositories: catalog.repositories.slice(0, REGISTRATION_REPOSITORY_CHOICE_LIMIT) };
}

/** The repositories a summon offers Jev. One that names its `repo:` offers
 * exactly that repository and reads no catalog; otherwise the catalog is read,
 * and a read that fails offers no repository rather than refusing the launch. */
export function summonRepositoryCatalog(reader: RegistrationRepositoryReader | undefined, actorUserId: string,
  repo: string | undefined): Promise<RegistrationRepositoryCatalog | undefined> | undefined {
  const named = registrationRepository(repo);
  if (named) return Promise.resolve({ repositories: [named] });
  return reader?.(actorUserId).then(repositoryCatalogForSummon, () => undefined);
}
