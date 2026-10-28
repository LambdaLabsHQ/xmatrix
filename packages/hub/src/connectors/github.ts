import { dispatchProductGitHubConnectorAfterAuthorityMessage } from "../product-github-connector-authority-adapter";
import { isGitHubConnectorCommand } from "./github-command";
import type { ConnectorProvider } from "./provider";

export const githubConnectorProvider: ConnectorProvider = {
  id: "github",
  commands: { accepts: isGitHubConnectorCommand, run: dispatchProductGitHubConnectorAfterAuthorityMessage },
};
