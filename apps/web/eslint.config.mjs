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
    files: ["src/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default config;
