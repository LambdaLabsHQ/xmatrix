import type {
  AppConnectorProviderId,
  AppConnectorProviderKind,
  AppConnectorProviderStatus,
  CommandCompletionArgumentSchema,
  CommandCompletionDelimiter,
} from "./authority.js";
import { EVENT_CONNECTOR_MANIFESTS } from "./app-connector-event-manifests.js";

// Public Integration Issue Read & Write includes both event scopes in Sentry's native UI.
// This exact set is shared by provider exchange/refresh and durable installation admission.
export const SENTRY_PUBLIC_INTEGRATION_SCOPES = [
  "event:read", "event:write", "org:read", "project:read",
] as const;

export interface AppConnectorProviderManifest {
  id: AppConnectorProviderId;
  name: string;
  kind: AppConnectorProviderKind;
  status: AppConnectorProviderStatus;
  description: string;
  auth: {
    type: "oauth" | "api-token";
    scopes: string[];
    secretRefs: string[];
    capabilities?: Array<{
      id: string;
      label: string;
      description: string;
      scopes: string[];
    }>;
  };
  connectionMetadata?: Array<{
    id: string;
    label: string;
    description: string;
    required?: boolean;
    placeholder?: string;
    pattern?: string;
    /** Defaults to string. string-list stores a bounded string array (not encoded text). */
    valueType?: "string" | "string-list";
    /** Max items when valueType is string-list. Defaults to 32. */
    maxItems?: number;
    /** Max length per list item when valueType is string-list. Defaults to 80. */
    itemMaxLength?: number;
  }>;
  /**
   * Values the connection keeps in the encrypted connector credential store
   * (docs/design/connector-platform.md §3.2). A `generated` value is minted by
   * the Hub and shown to Space admins so they can paste it into the provider;
   * any other value is written by an admin and never read back.
   */
  /**
   * One-click OAuth (docs/design/connector-platform.md §3.2). Offered only
   * when the Hub has this provider's client id and secret configured; the
   * token lands in the connection's encrypted credentials as `tokenField`.
   */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    scopeSeparator?: " " | ",";
    /** How the code is exchanged: form-encoded or JSON body. */
    tokenRequest?: "form" | "json";
    /** Client credentials in the body (default) or as HTTP Basic auth. */
    clientAuth?: "body" | "basic";
    /** Confidential providers that require a server-held S256 proof. */
    pkce?: "S256";
    tokenField: string;
    extraAuthorizeParams?: Record<string, string>;
    /**
     * Vercel external Integration installs use their registered slug and completion redirect;
     * Composio signs the account in with its own verified app (client id = Composio auth config, secret = Composio API key).
     */
    flow?: "vercel-integration" | "composio";
  };
  credentials?: Array<{
    id: string;
    label: string;
    description: string;
    generated?: boolean;
    /** Written only by the Hub itself (OAuth tokens); never shown, minted, or typed. */
    managed?: boolean;
    required?: boolean;
  }>;
  /**
   * Inbound events (§3.3). A Channel subscribes with
   * `@<provider>:subscribe:<source> <feature…|all>`; each delivery is routed to
   * the Channels subscribed to its source and feature.
   */
  events?: {
    source: { label: string; description: string; pattern: string; placeholder: string };
    features: Array<{ id: string; label: string; description: string }>;
    defaultFeatures: string[];
  };
  actions: Array<{
    id: string;
    label: string;
    description: string;
    requiredCapabilities?: string[];
    /**
     * What the action does to the provider (§3.5). Every action runs for a
     * Human or an Agent unless a Space admin denies it in the Channel. Absent
     * means a Channel-local action such as subscribe.
     */
    effect?: "read" | "write";
    /** How to write the command after `@<provider>:<action>`, shown in completion and help. */
    usage?: string;
    completion?: {
      trailingDelimiter?: CommandCompletionDelimiter;
      arguments?: CommandCompletionArgumentSchema;
    };
  }>;
}

const GITHUB_REPOSITORY_ARGUMENT: CommandCompletionArgumentSchema = {
  id: "github-repository",
  label: "GitHub repository",
  source: "github-repositories",
  trailingDelimiter: " ",
};

const GITHUB_REPOSITORY_REF_ARGUMENT: CommandCompletionArgumentSchema = {
  ...GITHUB_REPOSITORY_ARGUMENT,
  trailingDelimiter: ":",
};

function githubOrganizationArgument(
  repository: CommandCompletionArgumentSchema
): CommandCompletionArgumentSchema {
  return {
    id: "github-organization",
    label: "GitHub owner or organization",
    source: "github-organizations",
    trailingDelimiter: "/",
    next: repository,
  };
}

const GITHUB_ORGANIZATION_REPOSITORY_ARGUMENT = githubOrganizationArgument(
  GITHUB_REPOSITORY_ARGUMENT
);

const GITHUB_ORGANIZATION_REPOSITORY_REF_ARGUMENT = githubOrganizationArgument(
  GITHUB_REPOSITORY_REF_ARGUMENT
);

/* The repository-subscription vocabulary. The Hub matches webhook events onto
   these names and the web app offers them as the per-channel subscription
   controls, so both sides have to read the same list. */
export const GITHUB_REPOSITORY_FEATURES = [
  "issues", "pulls", "comments", "reviews", "commits", "checks", "status", "releases",
] as const;

export type GitHubRepositoryFeature = (typeof GITHUB_REPOSITORY_FEATURES)[number];

export const GITHUB_REPOSITORY_FEATURE_LABELS: Record<GitHubRepositoryFeature, string> = {
  issues: "Issues",
  pulls: "Pull requests",
  comments: "Comments",
  reviews: "Reviews",
  commits: "Commits",
  checks: "Checks",
  status: "Status & workflows",
  releases: "Releases",
};

/** The feature set `@github:subscribe:<owner>/<repo>` applies when none is named. */
export const GITHUB_DEFAULT_REPOSITORY_FEATURES: readonly GitHubRepositoryFeature[] = [
  "issues", "comments",
];

/** Connection capabilities a feature cannot be delivered without. */
export function githubRequiredCapabilities(
  features: readonly GitHubRepositoryFeature[],
): string[] {
  const result = new Set<string>();
  if (features.includes("commits")) result.add("github.metadata.read");
  if (features.some((feature) => feature === "issues" || feature === "comments")) {
    result.add("github.issues.read");
  }
  if (features.some((feature) => feature === "pulls" || feature === "reviews")) {
    result.add("github.pull_requests.read");
  }
  if (features.includes("checks")) result.add("github.checks.read");
  return [...result];
}

export const APP_CONNECTOR_PROVIDER_MANIFESTS: AppConnectorProviderManifest[] = [
  {
    id: "github",
    name: "GitHub",
    kind: "code-host",
    status: "available",
    description: "Route repository commits, issues, pull requests, checks, and release events into xMatrix channels.",
    auth: {
      type: "oauth",
      scopes: [
        "metadata:read",
        "contents:read",
        "contents:write",
        "issues:read",
        "issues:write",
        "pull_requests:read",
        "pull_requests:write",
        "checks:read",
        "checks:write",
        "actions:write",
        "workflows:write",
      ],
      secretRefs: [
        "GITHUB_APP_ID",
        "GITHUB_APP_CLIENT_ID",
        "GITHUB_APP_CLIENT_SECRET",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_WEBHOOK_SECRET",
      ],
      capabilities: [
        {
          id: "github.metadata.read",
          label: "Read code and repository metadata",
          description: "Resolve repositories and receive commit push updates without exposing installation tokens.",
          scopes: ["metadata:read"],
        },
        {
          id: "github.contents.read",
          label: "Read repository contents",
          description: "Clone and fetch repository code with a short-lived, repository-scoped installation token.",
          scopes: ["contents:read"],
        },
        {
          id: "github.contents.write",
          label: "Write repository contents",
          description: "Push branches with a short-lived, repository-scoped installation token.",
          scopes: ["contents:write"],
        },
        {
          id: "github.issues.read",
          label: "Read issues",
          description: "Import GitHub issue details and receive issue comment updates.",
          scopes: ["issues:read"],
        },
        {
          id: "github.issues.write",
          label: "Write issues",
          description: "Create approved GitHub issues and comments.",
          scopes: ["issues:write"],
        },
        {
          id: "github.pull_requests.read",
          label: "Read pull requests",
          description: "Import pull request metadata and receive pull request review updates.",
          scopes: ["pull_requests:read"],
        },
        {
          id: "github.pull_requests.write",
          label: "Write pull request comments",
          description: "Create approved comments on GitHub pull requests.",
          scopes: ["pull_requests:write"],
        },
        {
          id: "github.checks.read",
          label: "Read checks",
          description: "Read check run and check suite status for subscribed pull requests.",
          scopes: ["checks:read"],
        },
        {
          id: "github.checks.write",
          label: "Write checks",
          description: "Report agent review outcomes as check runs so a protected branch can require them.",
          scopes: ["checks:write"],
        },
        {
          id: "github.actions.write",
          label: "Run GitHub Actions workflows",
          description: "Rerun failed jobs or dispatch a named workflow with bounded typed inputs.",
          scopes: ["actions:write"],
        },
        {
          id: "github.workflows.write",
          label: "Write workflow definitions",
          description: "Push changes to .github/workflows, which GitHub gates behind its own permission.",
          scopes: ["workflows:write"],
        },
      ],
    },
    connectionMetadata: [
      {
        id: "repository",
        label: "Default repository",
        description: "Repository used to resolve short issue references like #42.",
        placeholder: "owner/repo",
        pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
      },
      {
        id: "installationId",
        label: "Installation reference",
        description: "Most recent opaque GitHub App installation reference (legacy single-value). Prefer installationIds.",
        placeholder: "github-installation-ref",
      },
      {
        id: "installationIds",
        label: "Installation references",
        description: "Bounded list of GitHub App installation ids (one User/Org account each). Not a comma-encoded string.",
        placeholder: "installation-id",
        pattern: "^[A-Za-z0-9_-]+$",
        valueType: "string-list",
        maxItems: 32,
        itemMaxLength: 80,
      },
      {
        id: "commentWriteChannelId",
        label: "Comment write channel",
        description: "Channel id where the GitHub comment action is explicitly enabled.",
        placeholder: "channel-id",
        pattern: "^[A-Za-z0-9_-]+$",
      },
      {
        id: "createIssueWriteChannelId",
        label: "Create issue write channel",
        description: "Channel id where the GitHub create issue action is explicitly enabled.",
        placeholder: "channel-id",
        pattern: "^[A-Za-z0-9_-]+$",
      },
      {
        id: "closeReopenWriteChannelId",
        label: "Close/reopen write channel",
        description: "Channel id where GitHub close and reopen actions are explicitly enabled.",
        placeholder: "channel-id",
        pattern: "^[A-Za-z0-9_-]+$",
      },
      {
        id: "actionsWriteChannelId",
        label: "Actions write channel",
        description: "Channel id where GitHub Actions rerun and workflow dispatch actions are explicitly enabled.",
        placeholder: "channel-id",
        pattern: "^[A-Za-z0-9_-]+$",
      },
      {
        id: "actionsWorkflowIds",
        label: "Allowed workflow ids",
        description: "Workflow file names or numeric ids that the dispatch action may invoke.",
        placeholder: "release-request.yml",
        pattern: "^(?:[1-9][0-9]*|[A-Za-z0-9_.-]+\\.ya?ml)$",
        valueType: "string-list",
        maxItems: 32,
        itemMaxLength: 128,
      },
      {
        id: "reviewWriteChannelId",
        label: "Review write channel",
        description: "Channel id where GitHub pull request review actions are explicitly enabled.",
        placeholder: "channel-id",
        pattern: "^[A-Za-z0-9_-]+$",
      },
    ],
    actions: [
      {
        id: "subscribe",
        /* Writes nothing to GitHub, but brings its content into the Channel,
           so a Channel's policy may deny it. */
        effect: "read",
        label: "Subscribe repository, issue, or PR",
        description: "Link the current channel or thread to repository-wide commit, issue, and pull request updates, or to one issue or PR. Use all for every repository feature; each feature requires its matching read access.",
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_ARGUMENT,
        },
      },
      {
        id: "unsubscribe",
        label: "Unsubscribe repository, issue, or PR",
        description: "Remove the current channel or thread subscription for a GitHub repository, issue, or PR, remove selected features, or use all to remove every repository feature.",
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_ARGUMENT,
        },
      },
      {
        id: "comment",
        effect: "write",
        label: "Comment on issue or PR",
        description: "Create a GitHub issue or pull request timeline comment.",
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_REF_ARGUMENT,
        },
      },
      {
        id: "create_issue",
        effect: "write",
        label: "Create issue",
        description: "Create a GitHub issue in a configured repository.",
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_ARGUMENT,
        },
      },
      {
        id: "close_issue",
        effect: "write",
        label: "Close issue or PR",
        description: "Close a GitHub issue or pull request.",
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_REF_ARGUMENT,
        },
      },
      {
        id: "reopen_issue",
        effect: "write",
        label: "Reopen issue or PR",
        description: "Reopen a GitHub issue or pull request.",
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_REF_ARGUMENT,
        },
      },
      {
        id: "review",
        effect: "write",
        label: "Review pull request",
        description: "Submit a GitHub pull request review.",
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_REF_ARGUMENT,
        },
      },
      {
        id: "merge",
        effect: "write",
        label: "Merge pull request",
        description: "Merge a GitHub pull request with the connected GitHub App.",
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_REF_ARGUMENT,
        },
      },
      {
        id: "rerun_failed_jobs",
        effect: "write",
        label: "Rerun failed workflow jobs",
        description: "Rerun only failed jobs in a numeric GitHub Actions run. Requires the GitHub App's Actions write permission.",
        requiredCapabilities: ["github.actions.write"],
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_REF_ARGUMENT,
        },
      },
      {
        id: "dispatch_workflow",
        effect: "write",
        label: "Dispatch workflow",
        description: "Dispatch a named workflow at an explicit ref with optional bounded JSON inputs. Requires the GitHub App's Actions write permission.",
        requiredCapabilities: ["github.actions.write"],
        completion: {
          trailingDelimiter: ":",
          arguments: GITHUB_ORGANIZATION_REPOSITORY_REF_ARGUMENT,
        },
      },
      {
        id: "policy",
        label: "Set action policy",
        description: "Space admins: allow a write action in this channel, deny it for everyone, or reset it to the default.",
        usage: "<action> allow|deny|default",
        completion: { trailingDelimiter: ":" },
      },
    ],
  },
  ...EVENT_CONNECTOR_MANIFESTS,
];
