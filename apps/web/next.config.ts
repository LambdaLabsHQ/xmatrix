import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

import CssSubjectBucketsPlugin from "./css-subject-buckets-webpack.mjs";
import {
  configuredHubConnectSources,
  configuredHubOrigin,
} from "./next-config-environment.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hubOrigin = configuredHubOrigin();

// A hosted CI browser shard builds the same tree that its run's `web` job
// already lints and type-checks, so it skips both (scripts/ci.mjs).
const skipBuildChecks = process.env.XMATRIX_NEXT_BUILD_SKIP_CHECKS === "1";
// Error reports go to the ingest origin of the build's DSN, when it has one.
const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

// `next dev` runs modules through eval and serves plain http on localhost.
const development = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // A dev server beside a built tree keeps its own output, so the build the
  // browser specs start from is not overwritten.
  ...(process.env.XMATRIX_NEXT_DIST_DIR ? { distDir: process.env.XMATRIX_NEXT_DIST_DIR } : {}),
  outputFileTracingRoot: join(__dirname, "../.."),
  ...(skipBuildChecks
    ? { eslint: { ignoreDuringBuilds: true }, typescript: { ignoreBuildErrors: true } }
    : {}),
  transpilePackages: ["@xmatrix/protocol"],
  // The Worker has no image optimizer binding: /_next/image answered every
  // width with the original file and no cache lifetime, so each view
  // downloaded it again. Images are shipped at the size they are drawn and
  // served directly, under worker.mjs's cache rules.
  images: { unoptimized: true },
  // A page rendered per request streams its title, description and canonical
  // into <body> for clients Next believes run scripts, Googlebot among them.
  // Search engines read those from <head>, so every client gets them there.
  htmlLimitedBots: /.*/u,
  // The user guide's Markdown is imported as text (src/lib/docs/guide.ts).
  turbopack: { rules: { "*.md": { loaders: ["./markdown-source-loader.cjs"], as: "*.js" } } },
  webpack(config, { dev, isServer }) {
    config.module.rules.push({ test: /\.md$/u, use: [join(__dirname, "markdown-source-loader.cjs")] });
    if (!dev && !isServer) config.plugins.push(new CssSubjectBucketsPlugin());
    return config;
  },
  // React Compiler memoizes components and hooks at build time, so a fresh
  // array, object or closure in render no longer breaks a child's memo. Live
  // Agent presence re-renders a busy Space many times a second; see the
  // client realtime rules on the 架构与性能 page.
  experimental: { reactCompiler: true },
  // A release that uploads browser source maps to error reporting builds them,
  // then removes them from the deployed assets (server-release.yml).
  productionBrowserSourceMaps: process.env.XMATRIX_WEB_SOURCE_MAPS === "1",
  async headers() {
    const connectSources = [
      "'self'",
      "https://cloudflareinsights.com",
      "https://accounts.google.com/gsi/",
      ...configuredHubConnectSources(hubOrigin),
      ...(sentryDsn ? [new URL(sentryDsn).origin] : []),
    ];
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""} https://static.cloudflareinsights.com https://accounts.google.com/gsi/client https://apis.google.com`,
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
      // Google Identity Services and the Docs Picker use their official provider frames.
      "frame-src 'self' https://accounts.google.com/gsi/ https://docs.google.com",
      // Uploaded avatars are served by the environment-specific Hub.
      `img-src 'self' data: blob: https://lh3.googleusercontent.com ${hubOrigin}`,
      // Direct Internet audio/video previews load only after a reader clicks Preview.
      `media-src 'self' blob: https: ${hubOrigin}`,
      "font-src 'self' data:",
      `connect-src ${Array.from(new Set(connectSources)).join(" ")}`,
      // `next dev` serves Web Workers from blob: URLs; built apps load them from 'self'.
      ...(development ? ["worker-src 'self' blob:"] : ["upgrade-insecure-requests"]),
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          // Only the stable Web is indexed; the beta Web serves the same pages.
          ...(process.env.NEXT_PUBLIC_XMATRIX_WEB_CHANNEL === "beta"
            ? [{ key: "X-Robots-Tag", value: "noindex, nofollow" }]
            : []),
        ],
      },
      ...["/connect/sentry", "/connect/wecom", "/connect/dingtalk"].map(source => ({ source, headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "private, no-store" },
      ] })),
    ];
  },
};

export default nextConfig;
