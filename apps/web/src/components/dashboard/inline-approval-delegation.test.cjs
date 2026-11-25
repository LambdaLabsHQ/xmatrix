const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const WEB_SRC = path.resolve(__dirname, "../..");

function createLoader(overrides = {}) {
  const modules = new Map();
  function resolveLocal(baseDir, id) {
    const base = id.startsWith("@/")
      ? path.join(WEB_SRC, id.slice(2))
      : path.resolve(baseDir, id);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  function load(file) {
    const abs = path.resolve(__dirname, file);
    if (modules.has(abs)) return modules.get(abs);
    const compiled = ts.transpileModule(readFileSync(abs, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: abs,
    }).outputText;
    const mod = { exports: {} };
    modules.set(abs, mod.exports);
    new Function("exports", "require", "module", compiled)(mod.exports, (id) => {
      if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
      if (id.startsWith(".") || id.startsWith("@/")) {
        const target = resolveLocal(path.dirname(abs), id);
        if (target) {
          const relKey = path.relative(__dirname, target);
          if (Object.prototype.hasOwnProperty.call(overrides, relKey)) return overrides[relKey];
          return load(target);
        }
      }
      return require(id);
    }, mod);
    modules.set(abs, mod.exports);
    return mod.exports;
  }
  return { load };
}

function stubQueryClient(queryData) {
  return {
    useQueryClient: () => ({ invalidateQueries: () => undefined, setQueryData: () => undefined }),
    useQuery: () => ({ data: queryData, isLoading: false, isError: false, error: null, refetch: () => undefined }),
    useMutation: () => ({ isPending: false, error: null, data: undefined, variables: undefined, mutate: () => undefined, mutateAsync: async () => undefined }),
  };
}

const iconProxy = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === "__esModule") return true;
    return (props) => React.createElement("svg", { "data-icon": String(prop), className: props?.className });
  },
});

const commonStubs = {
  "lucide-react": iconProxy,
  "@/components/ui/animated-icon": { AnimatedIcon: ({ icon: Icon, className }) => React.createElement(Icon, { className }) },
  "@/components/ui/error-notice": { ErrorNotice: () => null },
  "@/lib/query/use-query-fetch": { useXMatrixQueryFetch: () => async () => new Response("{}") },
  "@/lib/query/api-client": { errorFromResponse: async () => new Error("err"), xmatrixApiRequest: async () => ({}) },
  "@/lib/user-facing-error": { userErrorMessage: (err) => (err ? String(err) : null) },
  "@/lib/desktop/bridge": { getDesktopBridge: () => null },
  "@/lib/onboarding-locale": { useOnboardingCopy: () => ({ tellAgent: () => "", signedInResent: "", sendAgain: "", resendFailed: "" }) },
  "./page-reference-chip": { useNornRequest: () => ({ found: null }) },
  "./workspace-resource-push": { refetchUnlessHumanPush: () => false },
};

test("NornRequestCard renders Handle in side panel instead of Yes/No/Decline/Delegate in inline card mode", () => {
  const { load } = createLoader({
    ...commonStubs,
    "@tanstack/react-query": stubQueryClient(null),
  });
  const { NornRequestCard } = load("norn-request-card.tsx");
  const request = {
    ref: "req-1",
    verb: "confirm",
    holder: "@Daniel",
    holderUserId: "u1",
    text: "Deploy to production?",
    about: "Release",
    context: null,
    options: [],
    by: null,
    asker: "claude:1",
    otherwise: null,
    delegatedBy: null,
  };
  const inPanel = renderToStaticMarkup(React.createElement(NornRequestCard, {
    request, channelId: "ch-1", token: "tok", userId: "u1",
  }));
  assert.match(inPanel, />Yes</u);
  assert.match(inPanel, />No</u);
  assert.match(inPanel, /Decline/u);
  assert.match(inPanel, /Delegate/u);
  assert.doesNotMatch(inPanel, /data-handle-in-side-panel/u);

  const inCard = renderToStaticMarkup(React.createElement(NornRequestCard, {
    request, channelId: "ch-1", token: "tok", userId: "u1", onHandleInSidePanel: () => undefined,
  }));
  assert.match(inCard, /Deploy to production\?/u);
  assert.match(inCard, /data-handle-in-side-panel="true"/u);
  assert.match(inCard, /Handle in side panel/u);
  assert.doesNotMatch(inCard, />Yes</u);
  assert.doesNotMatch(inCard, />No</u);
  assert.doesNotMatch(inCard, /Decline/u);
  assert.doesNotMatch(inCard, /Delegate/u);
  assert.doesNotMatch(inCard, /<textarea/u);
});

test("ConnectorActionApproval renders Handle in side panel instead of Allow once / Disallow in inline card mode", () => {
  const { load } = createLoader({
    ...commonStubs,
    "@tanstack/react-query": stubQueryClient(null),
    "@xmatrix/protocol": {
      APP_CONNECTOR_PROVIDER_MANIFESTS: [{ id: "gmail", name: "Gmail" }],
      WEB_PROXY_ROUTES: { channel_connector_action_requests: () => "", channel_connector_action_request: () => "" },
    },
  });
  const { ConnectorActionApproval } = load("connector-action-approval.tsx");
  const request = {
    requestId: "act-1",
    channelId: "ch-1",
    providerId: "gmail",
    actionId: "send_email",
    requestedBy: "claude:1",
    preview: { to: "a@example.test", subject: "Hi", body: "Hello" },
    expiresAt: "2026-12-01T00:00:00.000Z",
  };
  const inPanel = renderToStaticMarkup(React.createElement(ConnectorActionApproval, {
    request, token: "tok", userId: "u1",
  }));
  assert.match(inPanel, /Allow once/u);
  assert.match(inPanel, /Disallow/u);

  const inCard = renderToStaticMarkup(React.createElement(ConnectorActionApproval, {
    request, token: "tok", userId: "u1", onHandleInSidePanel: () => undefined,
  }));
  assert.match(inCard, /Send this email\?/u);
  assert.match(inCard, /data-handle-in-side-panel="true"/u);
  assert.doesNotMatch(inCard, /Allow once/u);
  assert.doesNotMatch(inCard, /Disallow/u);
});

test("CrossSpaceReadCard renders Handle in side panel instead of Approve / Deny in inline card mode", () => {
  const { load } = createLoader({
    ...commonStubs,
    "@tanstack/react-query": stubQueryClient({
      channelId: "ch-other",
      scope: "space",
      status: "pending",
      reason: "Check incident notes",
      agentName: "claude:1",
      expiresAt: "2026-12-01T00:00:00.000Z",
      readCount: 0,
    }),
  });
  const { CrossSpaceReadCard } = load("cross-space-read-card.tsx");
  const request = { grantId: "g1", spaceId: "sp-2", ownerUserId: "u1", agentName: "claude:1" };

  const inPanel = renderToStaticMarkup(React.createElement(CrossSpaceReadCard, {
    request, token: "tok", userId: "u1",
  }));
  assert.match(inPanel, /Approve/u);
  assert.match(inPanel, /Deny/u);
  assert.match(inPanel, /Only this Channel/u);

  const inCard = renderToStaticMarkup(React.createElement(CrossSpaceReadCard, {
    request, token: "tok", userId: "u1", onHandleInSidePanel: () => undefined,
  }));
  assert.match(inCard, /data-handle-in-side-panel="true"/u);
  assert.doesNotMatch(inCard, /Approve/u);
  assert.doesNotMatch(inCard, /Deny/u);
  assert.doesNotMatch(inCard, /Only this Channel/u);
});

test("QuestionnaireMessage renders read-only options and Handle in side panel in inline card mode", () => {
  const { load } = createLoader({
    ...commonStubs,
    "@tanstack/react-query": stubQueryClient(null),
  });
  const { QuestionnaireMessage } = load("questionnaire-card.tsx");
  const questionnaire = {
    kind: "xmatrix.questionnaire.v1",
    harness: "Claude Code",
    questions: [{
      id: "q1",
      label: "Which mode?",
      selectionMode: "single",
      allowOther: true,
      options: [{ id: "o1", label: "Fast" }, { id: "o2", label: "Safe" }],
    }],
  };
  const message = { id: "m1", messageId: "m1", body: "" };

  const inPanel = renderToStaticMarkup(React.createElement(QuestionnaireMessage, {
    questionnaire, message, onAnswer: async () => true,
  }));
  assert.match(inPanel, /Send answer/u);
  assert.match(inPanel, /<input[^>]+type="radio"/u);
  assert.match(inPanel, /<input[^>]+type="text"/u);

  const inCard = renderToStaticMarkup(React.createElement(QuestionnaireMessage, {
    questionnaire, message, onAnswer: async () => true, onHandleInSidePanel: () => undefined,
  }));
  assert.match(inCard, /Which mode\?/u);
  assert.match(inCard, /Fast/u);
  assert.match(inCard, /data-handle-in-side-panel="true"/u);
  assert.doesNotMatch(inCard, /Send answer/u);
  assert.doesNotMatch(inCard, /<input/u);
});

test("SecretRequestCardView and SecretAccessRequestCardView hide secret inputs/checkboxes in inline card mode", () => {
  const { load: loadSecret } = createLoader({
    ...commonStubs,
    "@tanstack/react-query": stubQueryClient({ saved: false, readable: false, canApprove: true, envName: "API_KEY" }),
  });
  const { SecretRequestCardView } = loadSecret("secret-request-card.tsx");
  const secretReq = { runId: "r1", channelId: "ch-1", secretRef: "stripe-key", agentName: "claude:1" };

  const secretInPanel = renderToStaticMarkup(React.createElement(SecretRequestCardView, {
    request: secretReq, messageId: "m1", token: "tok", userId: "u1",
  }));
  assert.match(secretInPanel, /<input[^>]+type="password"/u);
  assert.match(secretInPanel, />Save</u);

  const secretInCard = renderToStaticMarkup(React.createElement(SecretRequestCardView, {
    request: secretReq, messageId: "m1", token: "tok", userId: "u1", onHandleInSidePanel: () => undefined,
  }));
  assert.match(secretInCard, /data-handle-in-side-panel="true"/u);
  assert.doesNotMatch(secretInCard, /<input/u);
  assert.doesNotMatch(secretInCard, />Save</u);

  const { load: loadAccess } = createLoader({
    ...commonStubs,
    "@tanstack/react-query": stubQueryClient({
      canApprove: true,
      access: new Map([["s1", { automatic: false }], ["s2", { automatic: false }]]),
    }),
  });
  const { SecretAccessRequestCardView } = loadAccess("secret-request-card.tsx");
  const accessReq = { runId: "r1", channelId: "ch-1", secretRefs: ["s1", "s2"], agentName: "claude:1" };

  const accessInCard = renderToStaticMarkup(React.createElement(SecretAccessRequestCardView, {
    request: accessReq, messageId: "m2", token: "tok", userId: "u1", onHandleInSidePanel: () => undefined,
  }));
  assert.match(accessInCard, /data-handle-in-side-panel="true"/u);
  assert.doesNotMatch(accessInCard, /<input[^>]+type="checkbox"/u);
  assert.equal((accessInCard.match(/<button\b/gu) ?? []).length, 1);
  assert.doesNotMatch(accessInCard, /<button[^>]*>[\s\S]*Let Agents read/u);
});

test("SettingsCard and HarnessSignedOutNotice delegate controls to side panel in inline card mode", () => {
  const { load: loadSettings } = createLoader({
    ...commonStubs,
    "@tanstack/react-query": stubQueryClient({
      spaceId: "sp-1",
      satisfied: false,
      askedBy: "claude:1",
      settings: [{
        address: "connector.googleplay.reportsBucket",
        label: "Allow write access",
        scope: "Google Play",
        control: "grant",
        satisfied: false,
        canWrite: true,
        writer: "space-admin",
      }],
    }),
    "./connector-credentials": { CredentialValueForm: () => React.createElement("form", null, "cred-form") },
    "./harness-sign-in": { HarnessSignInSection: () => React.createElement("button", null, "Sign in harness") },
  });
  const { SettingsCard } = loadSettings("settings-card.tsx");
  const settingsInPanel = renderToStaticMarkup(React.createElement(SettingsCard, {
    channelId: "ch-1", messageId: "m1", sequence: 1, token: "tok", userId: "u1",
  }));
  assert.match(settingsInPanel, />Allow</u);

  const settingsInCard = renderToStaticMarkup(React.createElement(SettingsCard, {
    channelId: "ch-1", messageId: "m1", sequence: 1, token: "tok", userId: "u1", onHandleInSidePanel: () => undefined,
  }));
  assert.match(settingsInCard, /data-handle-in-side-panel="true"/u);
  assert.doesNotMatch(settingsInCard, />Allow</u);

  const { load: loadSignedOut } = createLoader({
    ...commonStubs,
    "@tanstack/react-query": stubQueryClient(null),
    "./use-installed-harnesses": {
      useInstalledHarnesses: () => ({
        catalog: { data: { registrations: [{ key: { ownerUserId: "u1", machineId: "m1", harness: "claude" }, machineName: "Mac" }] } },
        daemons: { data: [] },
      }),
    },
    "./harness-sign-in": { HarnessSignedOutBody: () => React.createElement("button", null, "Sign in on Mac") },
  });
  const { HarnessSignedOutNotice } = loadSignedOut("harness-signed-out-notice.tsx");
  const signedOutInCard = renderToStaticMarkup(React.createElement(HarnessSignedOutNotice, {
    signedOut: { machineId: "m1", harness: "claude", program: "Claude Code" },
    spaceId: "sp-1",
    token: "tok",
    userId: "u1",
    notice: React.createElement("p", null, "Claude Code needs sign-in"),
    onHandleInSidePanel: () => undefined,
  }));
  assert.match(signedOutInCard, /data-handle-in-side-panel="true"/u);
  assert.doesNotMatch(signedOutInCard, /Sign in on Mac/u);
});

test("workspace-shell-view never mounts BrowserReadApprovalDialog inside the inline web-page popover", () => {
  const source = readFileSync(path.join(__dirname, "workspace-shell-view.tsx"), "utf8");
  assert.match(source, /\{!inlinePopover && <BrowserReadApprovalDialog \/>\}/u);
});
