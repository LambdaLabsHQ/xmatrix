import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

const config = [
  {
    ignores: [
      ".next/**",
      ".open-next/**",
      "next-env.d.ts",
      "node_modules/**",
      "out/**",
      // Tests write gitignored OPFS fixtures under src/; Next lint must not
      // treat those leftovers as app source when e2e:build races unit tests.
      "src/lib/relay-v2/.xmatrix-*/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/no-unstable-nested-components": [
        "warn",
        {
          allowAsProps: true,
        },
      ],
      "react/no-did-update-set-state": "error",
      "react/no-did-mount-set-state": "warn",
    },
  },
  {
    // Every client request goes through the transport in src/lib/query
    // (docs/architecture/client-resilience.md): it is what turns a dropped
    // connection into a failure the shared retry rule recognises. A direct
    // fetch skips that and surfaces the browser's "Failed to fetch".
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      // The transport itself.
      "src/lib/query/api-client.ts",
      // Server code: Next route handlers and the Worker's Hub proxy hop.
      "src/app/api/**",
      "src/lib/xmatrix-proxy.ts",
      "src/lib/native-session.ts",
      "src/lib/pages/public-page.ts",
      "src/lib/github-release.ts",
      "src/lib/relay-v2/message-attachment-upload-proxy.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Use the xMatrix transport (src/lib/query/api-client.ts) so transient failures are classified and retried.",
        },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "fetch", message: "Use the xMatrix transport (src/lib/query/api-client.ts)." },
        { object: "globalThis", property: "fetch", message: "Use the xMatrix transport (src/lib/query/api-client.ts)." },
      ],
    },
  },
  {
    // A person reads a failure only through describeError / ErrorNotice
    // (src/lib/user-facing-error.ts, docs/architecture/client-resilience.md).
    // Raw exception text — a browser's "signal is aborted without reason", a
    // gateway's HTML, a code like "membership version conflict" — never reaches
    // the screen, and a failed response is read with errorFromResponse so its
    // status, code and retry policy survive.
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='message'][object.type='TSAsExpression'][object.typeAnnotation.typeName.name='Error']",
          message: "Show a failure with userErrorMessage(error, action) or <ErrorNotice>, not its raw message.",
        },
        {
          selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error'][consequent.property.name='message']",
          message: "Show a failure with userErrorMessage(error, action) or <ErrorNotice>, not its raw message.",
        },
        {
          selector: "NewExpression[callee.name='Error'][arguments.0.type='LogicalExpression'][arguments.0.left.property.name='error']",
          message: "Throw `await errorFromResponse(response)` so the status, code and retry policy survive.",
        },
        {
          selector: "JSXExpressionContainer MemberExpression[property.name='message'][object.name=/[eE]rror$/]",
          message: "Render a failure with <ErrorNotice>, not its raw message.",
        },
        {
          selector: "JSXExpressionContainer MemberExpression[property.name='message'][object.property.name=/[eE]rror$/]",
          message: "Render a failure with <ErrorNotice>, not its raw message.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default config;
