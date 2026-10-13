import { record } from "../command-support";
import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionContext, ConnectorActionStatement } from "../provider";
import { quoteRetrievedText } from "./common";
import { adsAccount, adsCurrency, adsCustomer, adsCustomerId, adsMicros, adsMutate, adsSearch } from "./google-ads-common";

// Campaign configuration only: no payer, account ownership, user access, customer
// lists, billing, conversion uploads, or arbitrary service/URL dispatch.
const OPERATIONS = new Set(["campaignBudgetOperation", "campaignOperation", "campaignCriterionOperation", "campaignAssetOperation",
  "adGroupOperation", "adGroupCriterionOperation", "adGroupAdOperation", "adGroupAssetOperation", "adOperation", "assetOperation",
  "assetGroupOperation", "assetGroupAssetOperation", "assetGroupSignalOperation"]);
const MASK = /^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)*(?:,[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)*)*$/u;
const REQUIRES = ["oauthToken", "customerId"];

/** Check all nested references, integer monetary fields and JSON shape before I/O. */
function boundedConfig(value: unknown, customer: string, depth = 0, count = { nodes: 0 }): boolean {
  if (++count.nodes > 2_000 || depth > 10) return false;
  if (typeof value === "string") {
    return value.length <= 8_000 && (!value.startsWith("customers/") ||
      new RegExp(`^customers/${customer}/[A-Za-z][A-Za-z0-9]*/[A-Za-z0-9_~.-]{1,180}$`, "u").test(value));
  }
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => boundedConfig(item, customer, depth + 1, count));
  if (value && typeof value === "object") return Object.entries(value).every(([key, item]) =>
    !["__proto__", "constructor", "prototype"].includes(key) && key.length <= 100 &&
    (!key.endsWith("Micros") || adsMicros(item)) && boundedConfig(item, customer, depth + 1, count));
  return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function parseMutations(statement: ConnectorActionStatement, validateOnly: boolean): Record<string, string> | string {
  const customer = adsCustomerId(statement.target);
  if (!customer || !statement.text.trim() || statement.text.length > 32_000) return "name the customer ID and a mutation JSON body (at most 32000 characters)";
  let body: Record<string, unknown>;
  try { body = record(JSON.parse(statement.text)); } catch { return "mutation body must be JSON"; }
  if (Object.keys(body).some(key => !["currencyCode", "mutateOperations"].includes(key)) ||
      typeof body.currencyCode !== "string" || !/^[A-Z]{3}$/u.test(body.currencyCode)) return "supply currencyCode and mutateOperations only";
  const operations = body.mutateOperations;
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 25 || !boundedConfig(operations, customer)) {
    return "supply 1-25 bounded operations for this customer; monetary Micros fields must be decimal strings";
  }
  for (const value of operations) {
    const wrapper = record(value);
    const [type] = Object.keys(wrapper);
    if (!type || Object.keys(wrapper).length !== 1 || !OPERATIONS.has(type)) return "unsupported Google Ads resource operation";
    const operation = record(wrapper[type]);
    const hasCreate = Object.hasOwn(operation, "create"), hasUpdate = Object.hasOwn(operation, "update");
    if (hasCreate === hasUpdate || Object.keys(operation).some(key => !["create", "update", "updateMask"].includes(key))) {
      return "each operation must create or update a resource; removal is not supported";
    }
    const resource = record(operation[hasCreate ? "create" : "update"]);
    if (!Object.keys(resource).length) return "supply a resource object";
    if (hasUpdate && (typeof resource.resourceName !== "string" || !resource.resourceName.startsWith(`customers/${customer}/`) ||
        typeof operation.updateMask !== "string" || operation.updateMask.length > 512 || !MASK.test(operation.updateMask))) {
      return "updates need this customer's resourceName and an explicit updateMask (no wildcard)";
    }
    if (hasCreate && operation.updateMask !== undefined) return "create operations cannot have an updateMask";
    if (!validateOnly && type === "campaignOperation") {
      if (hasCreate && resource.status !== "PAUSED") return "create campaigns as PAUSED; enable them with set_campaign_status after review";
      if (hasUpdate && (resource.status !== undefined || String(operation.updateMask).split(",").includes("status"))) {
        return "change campaign status with set_campaign_status, not mutate";
      }
    }
    if (type === "campaignBudgetOperation" && hasCreate && resource.explicitlyShared !== false) {
      return "new campaign budgets must explicitly set explicitlyShared=false";
    }
  }
  return { customer, currencyCode: body.currencyCode, operations: JSON.stringify(operations) };
}

function writeAuthority(context: ConnectorActionContext): NonNullable<ConnectorActionContext["authorizeWrite"]> {
  if (!context.authorizeWrite) throw new ProviderRequestError(403, "Google Ads writes require current Channel authorization");
  return context.authorizeWrite;
}

function mutationAction(validateOnly: boolean): ConnectorAction {
  const prepare: NonNullable<ConnectorAction["prepare"]> = async ({ credentials }, input) => {
    adsCustomer(credentials, input.customer);
    adsCurrency(await adsAccount(credentials, input.customer!), input.currencyCode);
    return input;
  };
  return {
    effect: validateOnly ? "read" : "write", requires: REQUIRES,
    parse: statement => parseMutations(statement, validateOnly),
    ...(validateOnly ? {} : { prepare }),
    async execute(context, input) {
      const authorize = validateOnly ? undefined : writeAuthority(context);
      await prepare(context, input);
      if (authorize) await authorize(); // Fresh policy after the provider preflight.
      const names = await adsMutate(context.credentials, input.customer!, JSON.parse(input.operations!), validateOnly);
      return { summary: validateOnly ? "Google Ads validated the operations; no resources were changed and no ads were enabled." :
        `Google Ads applied ${names.length} atomic operations in ${input.currencyCode}; new campaigns remain paused:\n` + quoteRetrievedText(names.join("\n")) };
    },
  };
}

function parseStatus(statement: ConnectorActionStatement): Record<string, string> | string {
  const target = statement.target.match(/^(\d{10}|\d{3}-\d{3}-\d{4})\/(\d{1,20})$/u);
  if (!target || statement.text.length > 1_000) return "name <customer ID>/<campaign ID> and a status JSON body";
  let body: Record<string, unknown>;
  try { body = record(JSON.parse(statement.text)); } catch { return "status body must be JSON"; }
  if (Object.keys(body).some(key => !["status", "currencyCode", "expectedDailyBudgetMicros"].includes(key)) ||
      typeof body.status !== "string" || !["ENABLED", "PAUSED"].includes(body.status)) return "status is ENABLED or PAUSED; removal is not supported";
  if (body.status === "ENABLED" && (!adsMicros(body.expectedDailyBudgetMicros) || BigInt(body.expectedDailyBudgetMicros) <= 0 ||
      typeof body.currencyCode !== "string" || !/^[A-Z]{3}$/u.test(body.currencyCode))) {
    return "enabling requires currencyCode and a positive expectedDailyBudgetMicros decimal string; this is an average budget, not a hard daily spending cap";
  }
  return { customer: adsCustomerId(target[1]!)!, campaign: target[2]!, status: String(body.status),
    ...(body.status === "ENABLED" ? { currencyCode: String(body.currencyCode), expectedDailyBudgetMicros: String(body.expectedDailyBudgetMicros) } : {}) };
}

async function statusPreflight({ credentials }: ConnectorActionContext, input: Record<string, string>): Promise<Record<string, string>> {
  adsCustomer(credentials, input.customer);
  const account = await adsAccount(credentials, input.customer!);
  if (input.status === "ENABLED") {
    adsCurrency(account, input.currencyCode);
    const rows = await adsSearch(credentials, input.customer!, "SELECT campaign.id, campaign.status, campaign.campaign_budget, " +
      "campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.period, campaign_budget.explicitly_shared " +
      `FROM campaign WHERE campaign.id = ${input.campaign} LIMIT 1`);
    const row = record(rows[0]), budget = record(row.campaignBudget);
    if (String(record(row.campaign).id ?? "") !== input.campaign || budget.explicitlyShared !== false ||
        budget.period !== "DAILY" || typeof budget.resourceName !== "string" ||
        !new RegExp(`^customers/${input.customer}/campaignBudgets/\\d{1,20}$`, "u").test(budget.resourceName) ||
        record(row.campaign).campaignBudget !== budget.resourceName ||
        (input.budget !== undefined && input.budget !== budget.resourceName) ||
        String(budget.amountMicros ?? "") !== input.expectedDailyBudgetMicros) {
      throw new ProviderRequestError(409, "Campaign or average daily budget changed, or the budget is shared; query it before enabling");
    }
    return { ...input, budget: budget.resourceName };
  }
  return input;
}

export const GOOGLE_ADS_MUTATION_ACTIONS: Record<string, ConnectorAction> = {
  validate_mutations: mutationAction(true),
  mutate: mutationAction(false),
  set_campaign_status: {
    effect: "write", requires: REQUIRES, parse: parseStatus, prepare: statusPreflight,
    async execute(context, input) {
      const authorize = writeAuthority(context);
      const checked = await statusPreflight(context, input);
      await authorize();
      // No provider CAS exists. Close the read/write race by applying the approved
      // amount and exact budget reference atomically with activation. A concurrent
      // conversion to a shared budget rejects this entire transaction at Google.
      const operations: Record<string, unknown>[] = [];
      if (input.status === "ENABLED") operations.push({ campaignBudgetOperation: {
        update: { resourceName: checked.budget, amountMicros: input.expectedDailyBudgetMicros, explicitlyShared: false },
        updateMask: "amountMicros,explicitlyShared",
      } });
      operations.push({ campaignOperation: {
        update: { resourceName: `customers/${input.customer}/campaigns/${input.campaign}`, status: input.status,
          ...(input.status === "ENABLED" ? { campaignBudget: checked.budget } : {}) },
        updateMask: input.status === "ENABLED" ? "status,campaignBudget" : "status",
      } });
      const names = await adsMutate(context.credentials, input.customer!, operations, false);
      return { summary: `Google Ads campaign ${names.at(-1)} is ${input.status}${input.status === "ENABLED"
        ? `; expected average daily budget ${input.expectedDailyBudgetMicros} micros ${input.currencyCode} (not a hard daily spending cap)` : ""}.` };
    },
  },
};
