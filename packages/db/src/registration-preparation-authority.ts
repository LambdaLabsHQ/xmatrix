import type { AuthorityDatabase } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import type { RegistrationRepositoryReader } from "./registration-repository-authority.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";

/** Both new and successor Runs prepare with uncached Space and directory authorities. */
export class RegistrationPreparationAuthority {
  constructor(protected readonly database: AuthorityDatabase, protected readonly directory: AuthorityDatabase,
    protected readonly placement: DatabasePlacementContext,
    protected readonly repositoryReader?: RegistrationRepositoryReader) {
    if ([database, directory].some(authority => authority.cacheMode !== "disabled")) {
      throw new RegistrationAccessError("cached_authority_forbidden", 500);
    }
  }
}
