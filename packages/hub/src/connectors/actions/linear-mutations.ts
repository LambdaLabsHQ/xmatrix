import type { ConnectorAction } from "../provider";
import { ProviderRequestError } from "../http";
import { linear, linearRecord, linearResult, linearTeamId, linearWrite, LINEAR_ID } from "./linear-api";
import { linearBoolean, linearColor, linearDate, linearEnum, linearHttpUrl, linearId, linearIds,
  linearInteger, linearIssueRef, linearName, linearNullable, linearStatement, linearText, linearTimestamp,
  type LinearFields } from "./linear-input";
import { LINEAR_ISSUE_FIELDS, LINEAR_PROJECT_FIELDS } from "./linear-resources";
import { requireText, titleAndBody } from "./common";

export const LINEAR_ISSUE_EDIT_FIELDS: LinearFields = {
  title: linearName, description: linearText(12_000), priority: linearInteger(0, 4),
  stateId: linearId, assigneeId: linearNullable(linearId), projectId: linearNullable(linearId),
  cycleId: linearNullable(linearId), parentId: linearNullable(linearIssueRef),
  projectMilestoneId: linearNullable(linearId), teamId: linearId,
  labelIds: linearIds, addedLabelIds: linearIds, removedLabelIds: linearIds,
  dueDate: linearNullable(linearDate), estimate: linearNullable(linearInteger(0, 1000)),
};
const PROJECT_FIELDS: LinearFields = { name: linearName, description: linearText(4000), content: linearText(12_000),
  statusId: linearId, priority: linearInteger(0, 4), leadId: linearNullable(linearId),
  teamIds: value => linearIds(value) && (value as string[]).length > 0, memberIds: linearIds,
  startDate: linearNullable(linearDate), targetDate: linearNullable(linearDate), color: linearColor };
const CYCLE_FIELDS: LinearFields = { name: linearName, description: linearText(4000),
  startsAt: linearTimestamp, endsAt: linearTimestamp, completedAt: linearNullable(linearTimestamp) };
const LABEL_FIELDS: LinearFields = { name: linearName, description: linearText(4000), color: linearColor,
  parentId: linearNullable(linearId), isGroup: linearBoolean };
const DOCUMENT_FIELDS: LinearFields = { title: linearName, content: linearText(12_000),
  projectId: linearNullable(linearId), issueId: linearNullable(linearId), cycleId: linearNullable(linearId),
  teamId: linearNullable(linearId), parentDocumentId: linearNullable(linearId) };

type MutationSpec = { operation: string; inputType: string; resource: string; selection: string; fields: LinearFields;
  target: "issue" | "team" | "teamOrAll" | "id" | "all"; required?: string[]; create?: boolean;
  teamField?: "teamId" | "teamIds"; injectTarget?: string };

async function issueIdentity(credentials: Readonly<Record<string, string>>, target: string): Promise<string> {
  if (LINEAR_ID.test(target)) return target;
  const data = await linear(credentials, "query($id: String!) { issue(id: $id) { id identifier } }", { id: target });
  const issue = linearRecord(data.issue);
  if (typeof issue.id !== "string" || issue.identifier !== target) {
    throw new ProviderRequestError(404, "Linear did not resolve this issue in the connected workspace");
  }
  return issue.id;
}

function mutation(spec: MutationSpec): ConnectorAction {
  return { effect: "write", requires: ["apiKey|oauthToken"],
    parse(statement) {
      const parsed = linearStatement(statement, spec.target, spec.fields, spec.required);
      if (typeof parsed === "string") return parsed;
      const data = JSON.parse(parsed.data!) as Record<string, unknown>;
      if (data.labelIds && (data.addedLabelIds || data.removedLabelIds)) {
        return "use labelIds to replace labels, or addedLabelIds/removedLabelIds to edit them, not both";
      }
      if (data.startsAt && data.endsAt && Date.parse(String(data.endsAt)) <= Date.parse(String(data.startsAt))) {
        return "cycle endsAt must be later than startsAt";
      }
      if (data.startDate && data.targetDate && String(data.targetDate) < String(data.startDate)) {
        return "project targetDate must not precede startDate";
      }
      return parsed;
    },
    async prepare({ credentials }, input) {
      return { ...input, ...(spec.target === "issue" ? { resolvedTarget: await issueIdentity(credentials, input.target!) } : {}),
        ...(spec.teamField && input.target !== "*" ? { resolvedTeam: await linearTeamId(credentials, input.target!) } : {}) };
    },
    async execute(context, input) {
      const data = JSON.parse(input.data!) as Record<string, unknown>;
      const target = input.resolvedTarget ?? (spec.target === "issue"
        ? await issueIdentity(context.credentials, input.target!) : input.target);
      if (spec.teamField && input.target !== "*") {
        const team = input.resolvedTeam ?? await linearTeamId(context.credentials, input.target!);
        data[spec.teamField] = spec.teamField === "teamIds" ? [team] : team;
      }
      if (spec.injectTarget) data[spec.injectTarget] = target;
      const item = await linearWrite(context,
        `mutation($input: ${spec.inputType}!${!spec.create ? ", $id: String!" : ""}) {
          ${spec.operation}(${!spec.create ? "id: $id, " : ""}input: $input) {
            success ${spec.resource} { ${spec.selection} } } }`,
        { input: data, ...(!spec.create ? { id: target } : {}) }, spec.operation, spec.resource);
      if (!spec.create && item.id !== target) throw new ProviderRequestError(502, "Linear returned a different mutation destination");
      return linearResult(spec.operation, item, spec.resource === "attachment" ? undefined : item.url);
    } };
}

function lifecycle(operation: string, target: "issue" | "id" = "id"): ConnectorAction {
  return { effect: "write", requires: ["apiKey|oauthToken"],
    parse: statement => linearStatement(statement, target, {}, [], true),
    async prepare({ credentials }, input) {
      return { ...input, ...(target === "issue" ? { resolvedTarget: await issueIdentity(credentials, input.target!) } : {}) };
    },
    async execute(context, input) {
      const id = input.resolvedTarget ?? (target === "issue" ? await issueIdentity(context.credentials, input.target!) : input.target);
      await linearWrite(context, `mutation($id: String!) { ${operation}(id: $id) { success } }`, { id }, operation);
      return { summary: `Linear confirmed ${operation}: ${input.target}` };
    } };
}

const issueCreateFields = Object.fromEntries(Object.entries(LINEAR_ISSUE_EDIT_FIELDS)
  .filter(([key]) => !["teamId", "addedLabelIds", "removedLabelIds"].includes(key)));
const createIssue = mutation({ operation: "issueCreate", inputType: "IssueCreateInput", resource: "issue",
  selection: LINEAR_ISSUE_FIELDS, fields: issueCreateFields, target: "team", required: ["title"], create: true, teamField: "teamId" });

export const LINEAR_MUTATION_ACTIONS: Record<string, ConnectorAction> = {
  create_issue: { ...createIssue,
    parse(statement) {
      if (statement.text.trimStart().startsWith("{")) return createIssue.parse(statement);
      const text = requireText(statement);
      if (!text) return "write a title and description, or a JSON issue object";
      const { title, body } = titleAndBody(text);
      return createIssue.parse({ target: statement.target, text: JSON.stringify({ title, description: body }) });
    } },
  update_issue: mutation({ operation: "issueUpdate", inputType: "IssueUpdateInput", resource: "issue",
    selection: LINEAR_ISSUE_FIELDS, fields: LINEAR_ISSUE_EDIT_FIELDS, target: "issue" }),
  comment: { ...mutation({ operation: "commentCreate", inputType: "CommentCreateInput", resource: "comment",
    selection: "id url body", fields: { body: linearText(4000), parentId: linearId }, target: "issue",
    required: ["body"], create: true, injectTarget: "issueId" }),
    parse(statement) {
      const body = requireText(statement);
      return body ? linearStatement({ target: statement.target, text: JSON.stringify({ body }) }, "issue",
        { body: linearNameOrBody }, ["body"]) : "write the comment after the issue";
    } },
  update_comment: mutation({ operation: "commentUpdate", inputType: "CommentUpdateInput", resource: "comment",
    selection: "id url body", fields: { body: linearNameOrBody }, target: "id", required: ["body"] }),
  delete_comment: lifecycle("commentDelete"),
  archive_issue: lifecycle("issueArchive", "issue"),
  unarchive_issue: lifecycle("issueUnarchive", "issue"),
  delete_issue: lifecycle("issueDelete", "issue"),
  create_relation: mutation({ operation: "issueRelationCreate", inputType: "IssueRelationCreateInput", resource: "issueRelation",
    selection: "id type issue { id identifier } relatedIssue { id identifier }",
    fields: { relatedIssueId: linearIssueRef, type: linearEnum("blocks", "duplicate", "related", "similar") },
    target: "issue", required: ["relatedIssueId", "type"], create: true, injectTarget: "issueId" }),
  delete_relation: lifecycle("issueRelationDelete"),
  create_project: mutation({ operation: "projectCreate", inputType: "ProjectCreateInput", resource: "project",
    selection: LINEAR_PROJECT_FIELDS, fields: Object.fromEntries(Object.entries(PROJECT_FIELDS).filter(([key]) => key !== "teamIds")),
    target: "team", required: ["name"], create: true, teamField: "teamIds" }),
  update_project: mutation({ operation: "projectUpdate", inputType: "ProjectUpdateInput", resource: "project",
    selection: LINEAR_PROJECT_FIELDS, fields: PROJECT_FIELDS, target: "id" }),
  archive_project: lifecycle("projectArchive"),
  unarchive_project: lifecycle("projectUnarchive"),
  create_cycle: mutation({ operation: "cycleCreate", inputType: "CycleCreateInput", resource: "cycle",
    selection: "id name number startsAt endsAt team { id key }", fields: CYCLE_FIELDS,
    target: "team", required: ["startsAt", "endsAt"], create: true, teamField: "teamId" }),
  update_cycle: mutation({ operation: "cycleUpdate", inputType: "CycleUpdateInput", resource: "cycle",
    selection: "id name number startsAt endsAt team { id key }", fields: CYCLE_FIELDS, target: "id" }),
  archive_cycle: lifecycle("cycleArchive"),
  create_label: mutation({ operation: "issueLabelCreate", inputType: "IssueLabelCreateInput", resource: "issueLabel",
    selection: "id name color description team { id key }", fields: LABEL_FIELDS,
    target: "teamOrAll", required: ["name"], create: true, teamField: "teamId" }),
  update_label: mutation({ operation: "issueLabelUpdate", inputType: "IssueLabelUpdateInput", resource: "issueLabel",
    selection: "id name color description team { id key }", fields: LABEL_FIELDS, target: "id" }),
  delete_label: lifecycle("issueLabelDelete"),
  create_document: mutation({ operation: "documentCreate", inputType: "DocumentCreateInput", resource: "document",
    selection: "id title url", fields: DOCUMENT_FIELDS, target: "all", required: ["title"], create: true }),
  update_document: mutation({ operation: "documentUpdate", inputType: "DocumentUpdateInput", resource: "document",
    selection: "id title url", fields: DOCUMENT_FIELDS, target: "id" }),
  delete_document: lifecycle("documentDelete"),
  create_milestone: mutation({ operation: "projectMilestoneCreate", inputType: "ProjectMilestoneCreateInput", resource: "projectMilestone",
    selection: "id name description targetDate", fields: { name: linearName, description: linearText(4000), targetDate: linearNullable(linearDate) },
    target: "id", required: ["name"], create: true, injectTarget: "projectId" }),
  update_milestone: mutation({ operation: "projectMilestoneUpdate", inputType: "ProjectMilestoneUpdateInput", resource: "projectMilestone",
    selection: "id name description targetDate", fields: { name: linearName, description: linearText(4000), targetDate: linearNullable(linearDate) }, target: "id" }),
  delete_milestone: lifecycle("projectMilestoneDelete"),
  create_project_update: mutation({ operation: "projectUpdateCreate", inputType: "ProjectUpdateCreateInput", resource: "projectUpdate",
    selection: "id body health url", fields: { body: linearNameOrBody, health: linearEnum("onTrack", "atRisk", "offTrack") },
    target: "id", required: ["body"], create: true, injectTarget: "projectId" }),
  update_project_update: mutation({ operation: "projectUpdateUpdate", inputType: "ProjectUpdateUpdateInput", resource: "projectUpdate",
    selection: "id body health url", fields: { body: linearNameOrBody, health: linearEnum("onTrack", "atRisk", "offTrack") }, target: "id" }),
  archive_project_update: lifecycle("projectUpdateArchive"),
  create_attachment: mutation({ operation: "attachmentCreate", inputType: "AttachmentCreateInput", resource: "attachment",
    selection: "id title url", fields: { title: linearName, url: linearHttpUrl, subtitle: linearText(1000) },
    target: "issue", required: ["title", "url"], create: true, injectTarget: "issueId" }),
  update_attachment: mutation({ operation: "attachmentUpdate", inputType: "AttachmentUpdateInput", resource: "attachment",
    selection: "id title url", fields: { title: linearName, subtitle: linearText(1000) }, target: "id", required: ["title"] }),
  delete_attachment: lifecycle("attachmentDelete"),
};

function linearNameOrBody(value: unknown): boolean {
  return typeof value === "string" && !!value.trim() && value.length <= 4000;
}
