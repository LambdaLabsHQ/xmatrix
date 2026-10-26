import type { ConnectorAction } from "../provider";
import { ProviderRequestError } from "../http";
import { LINEAR_ID, linear, linearPage, linearRecord, linearResult, linearTeamId } from "./linear-api";
import { LINEAR_PAGE_FIELDS, linearId, linearInteger, linearStatement, linearText } from "./linear-input";

export const LINEAR_ISSUE_FIELDS = `id identifier url title priority estimate dueDate labelIds updatedAt archivedAt
  state { id name type } team { id key } assignee { id name } project { id name } cycle { id number }
  parent { id identifier } projectMilestone { id name }`;
export const LINEAR_PROJECT_FIELDS = `id name url description status { id name type } priority
  startDate targetDate lead { id name } archivedAt updatedAt`;
const PAGE = "pageInfo { hasNextPage endCursor }";

function resource(field: string, fields: string, kind: "id" | "team" = "id"): ConnectorAction {
  return { effect: "read", requires: ["apiKey|oauthToken"],
    parse: statement => linearStatement(statement, kind, {}, [], true),
    async execute({ credentials }, input) {
      const id = kind === "team" ? await linearTeamId(credentials, input.target!) : input.target;
      const data = await linear(credentials, `query($id: String!) { ${field}(id: $id) { ${fields} } }`, { id });
      const item = linearRecord(data[field]);
      if (item.id !== id) throw new ProviderRequestError(502, "Linear did not confirm the requested resource");
      return linearResult(field, item, item.url);
    } };
}

function listing(field: string, fields: string, options: { filterType?: string; teamField?: "accessibleTeams"; kind?: "all" | "teamOrAll" } = {}): ConnectorAction {
  return { effect: "read", requires: ["apiKey|oauthToken"],
    parse: statement => linearStatement(statement, options.kind ?? "teamOrAll", LINEAR_PAGE_FIELDS, [], true),
    async execute({ credentials }, input) {
      const data = JSON.parse(input.data!) as Record<string, unknown>;
      const team = { [LINEAR_ID.test(input.target!) ? "id" : "key"]: { eq: input.target } };
      const filter = input.target === "*" ? {} : options.teamField
        ? { [options.teamField]: { some: team } } : field === "issueLabels"
          ? { or: [{ team }, { team: { null: true } }] } : { team };
      const result = await linear(credentials, `query($first: Int!, $after: String, $archived: Boolean${options.filterType ? `, $filter: ${options.filterType}` : ""}) {
        ${field}(first: $first, after: $after, includeArchived: $archived${options.filterType ? ", filter: $filter" : ""}) {
          nodes { ${fields} } ${PAGE} } }`,
      { first: data.limit ?? 25, after: data.after ?? null, archived: data.includeArchived ?? false,
        ...(options.filterType ? { filter } : {}) });
      return linearResult(field, linearPage(result[field], Number(data.limit ?? 25)));
    } };
}

function issueList(): ConnectorAction {
  return { effect: "read", requires: ["apiKey|oauthToken"],
    parse: statement => linearStatement(statement, "teamOrAll", { ...LINEAR_PAGE_FIELDS,
      query: linearText(250), stateId: linearId, assigneeId: linearId, projectId: linearId,
      cycleId: linearId, labelId: linearId, priority: linearInteger(0, 4) }, [], true),
    async execute({ credentials }, input) {
      const options = JSON.parse(input.data!) as Record<string, unknown>;
      const filter: Record<string, unknown> = {};
      if (input.target !== "*") filter.team = { [LINEAR_ID.test(input.target!) ? "id" : "key"]: { eq: input.target } };
      for (const key of ["state", "assignee", "project", "cycle"]) {
        if (options[`${key}Id`]) filter[key] = { id: { eq: options[`${key}Id`] } };
      }
      if (options.labelId) filter.labels = { some: { id: { eq: options.labelId } } };
      if (options.priority !== undefined) filter.priority = { eq: options.priority };
      const term = typeof options.query === "string" ? options.query.trim() : "";
      const field = term ? "searchIssues" : "issues";
      const result = await linear(credentials, `query($first: Int!, $after: String, $archived: Boolean, $filter: IssueFilter${term ? ", $term: String!" : ""}) {
        ${field}(first: $first, after: $after, includeArchived: $archived, filter: $filter${term ? ", term: $term" : ""}) {
          nodes { ${LINEAR_ISSUE_FIELDS} } ${PAGE} } }`,
      { first: options.limit ?? 25, after: options.after ?? null, archived: options.includeArchived ?? false,
        ...(term ? { term } : {}), filter });
      return linearResult("issues", linearPage(result[field], Number(options.limit ?? 25)));
    } };
}

function children(parent: "issue" | "project", field: string, fields: string): ConnectorAction {
  return { effect: "read", requires: ["apiKey|oauthToken"],
    parse: statement => linearStatement(statement, parent === "issue" ? "issue" : "id", LINEAR_PAGE_FIELDS, [], true),
    async execute({ credentials }, input) {
      const options = JSON.parse(input.data!) as Record<string, unknown>;
      const data = await linear(credentials, `query($id: String!, $first: Int!, $after: String, $archived: Boolean) {
        ${parent}(id: $id) { id ${field}(first: $first, after: $after, includeArchived: $archived) {
          nodes { ${fields} } ${PAGE} } } }`,
      { id: input.target, first: options.limit ?? 25, after: options.after ?? null, archived: options.includeArchived ?? false });
      const entity = linearRecord(data[parent]);
      if (!entity.id) throw new ProviderRequestError(404, `Linear ${parent} not found; check this Space's workspace access`);
      return linearResult(field, linearPage(entity[field], Number(options.limit ?? 25)));
    } };
}

export const LINEAR_RESOURCE_ACTIONS: Record<string, ConnectorAction> = {
  workspace: { effect: "read", requires: ["apiKey|oauthToken"],
    parse: statement => linearStatement(statement, "all", {}, [], true),
    async execute({ credentials }) {
      const data = await linear(credentials, "query { organization { id name urlKey } viewer { id name } }");
      if (!linearRecord(data.organization).id || !linearRecord(data.viewer).id) {
        throw new ProviderRequestError(502, "Linear did not identify the connected workspace");
      }
      return linearResult("workspace and current user", { organization: data.organization, viewer: data.viewer });
    } },
  list_teams: listing("teams", "id key name description", { kind: "all" }),
  read_team: resource("team", "id key name description cyclesEnabled", "team"),
  list_users: listing("users", "id name active", { kind: "all" }),
  list_states: listing("workflowStates", "id name type position team { id key }", { filterType: "WorkflowStateFilter" }),
  list_labels: listing("issueLabels", "id name description color isGroup team { id key }", { filterType: "IssueLabelFilter" }),
  list_cycles: listing("cycles", "id name number startsAt endsAt completedAt team { id key }", { filterType: "CycleFilter" }),
  read_cycle: resource("cycle", "id name number description startsAt endsAt completedAt progress team { id key }"),
  list_projects: listing("projects", LINEAR_PROJECT_FIELDS, { filterType: "ProjectFilter", teamField: "accessibleTeams" }),
  list_project_statuses: listing("projectStatuses", "id name type team { id key }", { kind: "all" }),
  read_project: resource("project", `${LINEAR_PROJECT_FIELDS} content`),
  search_issues: issueList(),
  list_issues: issueList(),
  list_comments: children("issue", "comments", "id body url createdAt updatedAt"),
  read_comment: resource("comment", "id body url createdAt updatedAt issue { id identifier }"),
  list_relations: children("issue", "relations", "id type issue { id identifier } relatedIssue { id identifier }"),
  list_subissues: children("issue", "children", LINEAR_ISSUE_FIELDS),
  list_attachments: children("issue", "attachments", "id title subtitle url"),
  list_milestones: children("project", "projectMilestones", "id name description targetDate status"),
  list_project_updates: children("project", "projectUpdates", "id body health url createdAt"),
  list_documents: listing("documents", "id title url updatedAt", { kind: "all" }),
  read_document: resource("document", "id title content url updatedAt project { id name }"),
};
