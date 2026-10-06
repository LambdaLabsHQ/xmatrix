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
    files: [
      "src/app/**/*.tsx",
      "src/components/**/*.tsx",
      "src/components/**/use-*.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "React HTTP server state must use a typed fetcher through TanStack Query.",
        },
      ],
    },
  },
  {
    // Reviewed protocol/transport boundaries. These files do not use HTTP as
    // ordinary React server state; keep this list explicit and small.
    files: [
      "src/app/login/page.tsx",
      "src/components/dashboard/workspace-admin-views.tsx",
      "src/components/dashboard/workspace-composer-dialogs.tsx",
      "src/components/dashboard/workspace-message-timeline.tsx",
      "src/components/dashboard/workspace-shell-formatters.tsx",
      "src/components/dashboard/workspace-shell-helpers.tsx",
      "src/components/dashboard/workspace-shell-helpers-extra.tsx",
      "src/components/dashboard/workspace-shell-recovered.tsx",
    ],
    rules: {
      "no-restricted-globals": "off",
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
