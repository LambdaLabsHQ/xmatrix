// Builds the Web's workspace app into files the extension ships and opens in
// its side panel: apps/web/src/extension-app/main.tsx and everything it
// imports, the Web's styles, and the public files they name. It is the same
// source the Web builds, with the same React Compiler pass; what differs is
// what stands in for Next (see the resolver below) and that the Web's proxy
// routes are bundled to run in the page.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { transformAsync } from "@babel/core";
import tailwind from "@tailwindcss/postcss";
import reactCompiler from "babel-plugin-react-compiler";
import * as esbuild from "esbuild";
import postcss from "postcss";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "../..");
const web = path.join(repo, "apps", "web");
const webSource = path.join(web, "src");
const appSource = path.join(webSource, "extension-app");
const apiSource = path.join(webSource, "app", "api");

/** Where the packaged page lives in the extension; its public files sit at the extension's root, as on the Web. */
export const APP_DIRECTORY = "app";
const ROUTES_MODULE = "xmatrix-extension:api-routes";
const TARGET = "chrome116";

/** What a proxy route may import and still run in a page: the protocol, and the hop this build supplies. */
const PAGE_SAFE_IMPORTS = [
  /^@xmatrix\/protocol(?:\/.*)?$/u,
  /^@\/lib\/xmatrix-proxy$/u,
  /^@\/lib\/xmatrix$/u,
  /^@\/lib\/relay-v2\/message-attachment-upload-proxy$/u,
];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

/**
 * The Web's Hub proxy routes that only name a Hub route and send the request
 * on. A route that needs the Web's server (its cookies, its session store, its
 * own secrets) is left out, and the page answers 404 for it.
 */
export function pageApiRoutes() {
  const routes = [];
  const skipped = [];
  for (const file of walk(path.join(apiSource, "xmatrix")).filter((name) => path.basename(name) === "route.ts").sort()) {
    const route = path.relative(apiSource, path.dirname(file)).split(path.sep).join("/");
    const imports = [...fs.readFileSync(file, "utf8").matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]);
    if (imports.length > 0 && imports.every((name) => PAGE_SAFE_IMPORTS.some((allowed) => allowed.test(name)))) {
      routes.push({ route, file });
    } else skipped.push(route);
  }
  return { routes, skipped };
}

function routesModule(routes) {
  const lines = routes.map(({ file }, index) => `import * as route${index} from ${JSON.stringify(file)};`);
  lines.push(`export const API_ROUTES = [${routes.map(({ route }, index) => `[${JSON.stringify(route)}, route${index}]`).join(", ")}];`);
  return lines.join("\n");
}

/** The modules that stand in for Next and for the Web's server hop. */
const REPLACED = new Map([
  ["next/navigation", path.join(appSource, "next-navigation.ts")],
  ["next/link", path.join(appSource, "next-link.tsx")],
  ["next/image", path.join(appSource, "next-image.tsx")],
  ["next/dynamic", path.join(appSource, "next-dynamic.tsx")],
  ["@/lib/xmatrix-proxy", path.join(appSource, "hub-proxy.ts")],
]);

const GOOGLE_DOC_FILE_SELECTION = path.join(webSource, "components", "dashboard", "google-doc-file-selection.tsx");
const EXTENSION_GOOGLE_DOC_FILE_SELECTION = path.join(appSource, "google-doc-file-selection.tsx");
const GOOGLE_DOC_PICKER = path.join(webSource, "lib", "google-doc-picker.ts");

function resolveWebImport(specifier, resolveDir) {
  return specifier.startsWith("@/")
    ? path.join(webSource, specifier.slice(2))
    : path.resolve(resolveDir, specifier);
}

const WORKER_URL = /new URL\((["'])\.\/([\w.-]+\.worker)\.ts\1,\s*import\.meta\.url\)/gu;

/** Workers the app starts by file (`new URL("./x.worker.ts", import.meta.url)`): each is built beside the app. */
function workerEntries() {
  const entries = new Map();
  for (const file of walk(path.join(webSource, "lib")).filter((name) => /\.tsx?$/u.test(name) && !name.includes(".test."))) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(WORKER_URL)) {
      entries.set(match[2], path.join(path.dirname(file), `${match[2]}.ts`));
    }
  }
  return entries;
}

const cacheDirectory = path.join(root, "node_modules", ".cache", "build-app");

/** The Web's React Compiler pass (next.config.ts `reactCompiler`), for a file that can hold a component or a hook. */
async function compileReact(file, source) {
  if (!/\buse[A-Z]|<[A-Za-z]|<>/u.test(source)) return source;
  const key = createHash("sha256").update(file).update("\0").update(source).digest("hex");
  const cached = path.join(cacheDirectory, `${key}.tsx`);
  try {
    return fs.readFileSync(cached, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const result = await transformAsync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    compact: false,
    plugins: [[reactCompiler, { target: "19" }]],
    parserOpts: { plugins: ["typescript", "jsx"] },
  });
  const code = result?.code ?? source;
  // Builds can run side by side: write a private file and rename it into
  // place, so a reader sees a whole entry or none, never a half-written one.
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const partial = `${cached}.${process.pid}.${randomUUID()}.partial`;
  fs.writeFileSync(partial, code);
  fs.renameSync(partial, cached);
  return code;
}

function appPlugin(routes, release) {
  return {
    name: "xmatrix-extension-app",
    setup(build) {
      // esbuild's filters are Go regular expressions: no `u` flag.
      build.onResolve({ filter: /^(?:next\/(?:navigation|link|image|dynamic)|@\/lib\/xmatrix-proxy)$/ }, (args) => ({
        path: REPLACED.get(args.path),
      }));
      // Chrome Manifest V3 forbids remotely hosted scripts (Blue Argon). Replace Google Picker's
      // component with a Web-tab link and fail the build if anything pulls in google-doc-picker.ts.
      build.onResolve({ filter: /(?:^|\/)google-doc-file-selection(?:\.tsx)?$/ }, (args) => {
        const resolved = resolveWebImport(args.path, args.resolveDir);
        if (resolved === GOOGLE_DOC_FILE_SELECTION || `${resolved}.tsx` === GOOGLE_DOC_FILE_SELECTION) {
          return { path: EXTENSION_GOOGLE_DOC_FILE_SELECTION };
        }
        return undefined;
      });
      build.onResolve({ filter: /(?:^|\/)google-doc-picker(?:\.ts)?$/ }, (args) => {
        const resolved = resolveWebImport(args.path, args.resolveDir);
        if (resolved === GOOGLE_DOC_PICKER || `${resolved}.ts` === GOOGLE_DOC_PICKER) {
          return {
            errors: [{
              text: "The extension cannot bundle google-doc-picker.ts: Chrome MV3 forbids remotely hosted scripts.",
            }],
          };
        }
        return undefined;
      });
      // Anything else of Next would bring its router and server runtime into the page.
      build.onResolve({ filter: /^next(?:\/|$)/ }, (args) => ({
        errors: [{ text: `The extension's app cannot bundle ${args.path}: give it a module in apps/web/src/extension-app.` }],
      }));
      build.onResolve({ filter: new RegExp(`^${ROUTES_MODULE}$`) }, () => ({ path: ROUTES_MODULE, namespace: "routes" }));
      build.onLoad({ filter: /.*/, namespace: "routes" }, () => ({ contents: routesModule(routes), resolveDir: appSource, loader: "ts" }));
      // The app names itself to the Hub by the repository's version; a build made for a release is that release.
      build.onLoad({ filter: /[\\/]version\.json$/ }, (args) => (args.path === path.join(repo, "version.json")
        ? { contents: JSON.stringify({ version: release }), loader: "json" }
        : undefined));
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        if (!args.path.startsWith(webSource + path.sep)) return undefined;
        const source = fs.readFileSync(args.path, "utf8").replace(WORKER_URL, 'new URL("./$2.js", import.meta.url)');
        return { contents: await compileReact(args.path, source), loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
      });
    },
  };
}

/**
 * The Web's build-time settings. Only two are set: the release, which is the
 * version the app names itself as to the Hub and the build its stale-build
 * check compares, and the Hub when a build is for another one. Everything else
 * is unset, as on the production Web: the production Hub, no mock session.
 */
function shared({ minify, release, hubUrl }) {
  return {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: TARGET,
    jsx: "automatic",
    minify,
    legalComments: "none",
    absWorkingDir: web,
    alias: { "@": webSource },
    loader: { ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_XMATRIX_WEB_BUILD_ID": JSON.stringify(release),
      ...(hubUrl ? { "process.env.NEXT_PUBLIC_XMATRIX_HUB_URL": JSON.stringify(hubUrl) } : {}),
      "process.env": "{}",
    },
    logLevel: "warning",
  };
}

async function buildScripts(out, settings) {
  const { routes, skipped } = pageApiRoutes();
  const workers = workerEntries();
  const result = await esbuild.build({
    ...shared(settings),
    entryPoints: { main: path.join(appSource, "main.tsx"), ask: path.join(appSource, "ask.tsx"), ...Object.fromEntries(workers) },
    outdir: out,
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    splitting: true,
    metafile: true,
    plugins: [appPlugin(routes, settings.release)],
  });
  return { routes: routes.length, skipped, bytes: Object.values(result.metafile.outputs).reduce((sum, file) => sum + file.bytes, 0) };
}

/** The Web's head scripts (extension-app/document-scripts.ts), as the file an extension page may load. */
async function buildDocumentScript(out, settings) {
  const result = await esbuild.build({
    ...shared({ ...settings, minify: false }),
    entryPoints: [path.join(appSource, "document-scripts.ts")],
    platform: "node",
    write: false,
  });
  const scripts = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  fs.writeFileSync(path.join(out, "document.js"), `${scripts.DOCUMENT_HEAD_SCRIPT}\n`);
}

async function buildStyles(out, minify) {
  const entry = path.join(appSource, "app.css");
  // Tailwind reads the Web's sources for the classes they use, as the Web's own build does.
  const result = await postcss([tailwind({ base: web, optimize: false })])
    .process(fs.readFileSync(entry, "utf8"), { from: entry, to: path.join(out, "app.css") });
  const css = minify
    ? (await esbuild.transform(result.css, { loader: "css", minify: true, target: TARGET, logLevel: "error" })).code
    : result.css;
  // The side panel is a desktop browser surface, not a phone: settle width media queries at desktop width
  // while keeping viewport-height units (dvh/vh) live so the panel fills Chrome's side panel height.
  fs.writeFileSync(path.join(out, "app.css"), desktopStylesheet(css, DESKTOP_WIDTH_PX, DESKTOP_HEIGHT_PX, { viewportUnits: false }));
  fs.writeFileSync(path.join(out, "ask.css"), desktopStylesheet(css));
  return css;
}

const PAGE = `<!doctype html>
<html id="xmatrix-side-panel" lang="en" class="font-sans light" data-app-theme="wood" style="color-scheme: light; background: #ffffff">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>xMatrix</title>
  <link rel="stylesheet" href="app.css">
  <link rel="modulepreload" href="main.js">
  <script src="document.js"></script>
  <style>
    /* Keep the exact native Channel floating glass-pill composer (Daniel 2026-11-25: no full-bleed
       dock override — use the same Channel composer in both the side panel and the inline dialog),
       with compact side-panel inset padding so the pill breathes cleanly at ~380px width. */
    #xmatrix-side-panel .xmatrix-app-shell .app-composer {
      padding-left: 0.75rem !important;
      padding-right: 0.75rem !important;
      padding-bottom: 0.875rem !important;
    }
    #xmatrix-side-panel .xmatrix-app-shell .rich-message :is(pre, code) {
      border: 0 !important;
      box-shadow: none !important;
      background: oklch(0.958 0.006 82) !important;
    }
  </style>
</head>
<body class="site-canvas antialiased" style="background: #ffffff">
  <script type="module" src="main.js"></script>
</body>
</html>
`;

/**
 * The question box a web page frames beside a selection (extension-app/ask.tsx,
 * src/selection.js): the App's stylesheet, on a clear page so only the App's
 * own surface shows over the page.
 */
const ASK_PAGE = `<!doctype html>
<html id="xmatrix-ask-box" lang="en" class="font-sans light" data-app-theme="wood" style="color-scheme: light; background: transparent">
<head>
  <meta charset="utf-8">
  <title>Ask xMatrix</title>
  <link rel="stylesheet" href="ask.css">
  <script src="document.js"></script>
  <style>
    /* Only the capsule and its shadow sit on the page: the App's paper behind the composer would show as a pale
       box over the page's text around it. In a frame the glass cannot blur the page behind it, so the capsule
       carries the paper itself (Daniel 2026-11-23: the box is the input alone). Keep the composer in normal flow
       so the frame measures its height directly without an async ResizeObserver stage loop.
       #xmatrix-ask-box guarantees higher specificity than globals.css's :root:not(.dark) .xmatrix-app .app-composer. */
    #xmatrix-ask-box,
    #xmatrix-ask-box body {
      height: 100%;
    }
    #xmatrix-ask-box .xmatrix-app { background: transparent !important; }
    #xmatrix-ask-box .xmatrix-app .app-composer {
      position: relative !important;
      inset: auto !important;
      width: 100% !important;
      padding: 0 !important;
      pointer-events: auto !important;
    }
    #xmatrix-ask-box .xmatrix-app .app-composer-box {
      --app-liquid-surface-bg: var(--background) !important;
      --app-liquid-shared-surface-bg: var(--background) !important;
    }
    @keyframes ask-card-morph {
      0% {
        height: var(--ask-morph-start-h, 3.25rem);
        border-radius: 26px;
        background-color: var(--background);
      }
      100% {
        height: var(--ask-morph-end-h, 30.5rem);
        border-radius: 20px;
        background-color: #ffffff;
      }
    }
    @keyframes ask-header-unfold {
      0% {
        height: 0;
        opacity: 0;
      }
      35% {
        opacity: 0;
      }
      100% {
        height: 2.5rem;
        opacity: 1;
      }
    }
    @keyframes ask-card-open {
      0% {
        opacity: 0;
        transform: translateY(6px) scale(0.985);
      }
      100% {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    #xmatrix-ask-box .ask-thread-card-expanding {
      animation: ask-card-morph 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    #xmatrix-ask-box .ask-thread-card-open {
      animation: ask-card-open 160ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    #xmatrix-ask-box .ask-thread-header-enter {
      overflow: hidden;
      animation: ask-header-unfold 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @media (prefers-reduced-motion: reduce) {
      #xmatrix-ask-box .ask-thread-card-expanding,
      #xmatrix-ask-box .ask-thread-card-open,
      #xmatrix-ask-box .ask-thread-header-enter {
        animation: none !important;
      }
    }
  </style>
</head>
<body class="site-canvas antialiased" style="margin: 0; background: transparent; overflow: hidden">
  <script type="module" src="ask.js"></script>
</body>
</html>
`;

/** Public directories the app names by pattern (an Agent's vendor mark, a connector's icon), copied whole. */
const PUBLIC_DIRECTORIES = ["agent-vendors", "app-connectors", "fonts", "role-avatars", "textures"];

/** Copies the Web's public files the built app names, to the same paths at the extension's root. */
function copyPublicFiles(extensionRoot, texts) {
  const publicRoot = path.join(web, "public");
  for (const directory of PUBLIC_DIRECTORIES) {
    fs.cpSync(path.join(publicRoot, directory), path.join(extensionRoot, directory), { recursive: true });
  }
  const named = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(/["'`(]\/((?:[\w-]+\/)*[\w.-]+\.(?:png|jpe?g|webp|svg|gif|ico|woff2))\b/gu)) named.add(match[1]);
  }
  for (const file of named) {
    const source = path.join(publicRoot, file);
    if (PUBLIC_DIRECTORIES.includes(file.split("/")[0]) || !fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(path.join(extensionRoot, file)), { recursive: true });
    fs.copyFileSync(source, path.join(extensionRoot, file));
  }
}

/** The window the question box's stylesheet is fixed at: a desktop one, as the App draws its comment box there. */
const DESKTOP_WIDTH_PX = 1280;
const DESKTOP_HEIGHT_PX = 800;

/** One width condition of a media query, at `width` px: true, false, or null when it is not one. */
export function widthCondition(text, width = DESKTOP_WIDTH_PX) {
  const px = (value, unit) => Number(value) * (unit === "rem" || unit === "em" ? 16 : 1);
  const legacy = text.match(/^\(\s*(min|max)-width\s*:\s*([\d.]+)(px|rem|em)\s*\)$/u);
  if (legacy) return legacy[1] === "min" ? width >= px(legacy[2], legacy[3]) : width <= px(legacy[2], legacy[3]);
  const range = text.match(/^\(\s*width\s*(>=|<=|>|<)\s*([\d.]+)(px|rem|em)\s*\)$/u);
  if (!range) return null;
  const bound = px(range[2], range[3]);
  return { ">=": width >= bound, "<=": width <= bound, ">": width > bound, "<": width < bound }[range[1]];
}

/**
 * The App's stylesheet as a desktop window applies it, for the question box a
 * web page frames (extension-app/ask.tsx). The frame is only as wide as the
 * box, so the App's width queries would take it for a phone; here each one is
 * settled at a desktop width instead: kept rules lose the query, the others go.
 * Queries on anything but width (hover, reduced motion) stay as they are.
 * Lengths in viewport units are the window's too, not the frame's: a field
 * capped at a third of the viewport would otherwise be a third of the box.
 */
export function desktopStylesheet(css, width = DESKTOP_WIDTH_PX, height = DESKTOP_HEIGHT_PX, { viewportUnits = true } = {}) {
  const root = postcss.parse(css);
  if (viewportUnits) {
    const units = { vh: height / 100, dvh: height / 100, svh: height / 100, lvh: height / 100,
      vw: width / 100, dvw: width / 100, svw: width / 100, lvw: width / 100 };
    root.walkDecls((decl) => {
      if (decl.prop.startsWith("--") && !/\d(?:[dsl]?v[hw])\b/u.test(decl.value)) return;
      decl.value = decl.value.replace(/(-?\d*\.?\d+)([dsl]?v[hw])\b/gu, (_, value, unit) => `${+(Number(value) * units[unit]).toFixed(3)}px`);
    });
  }
  root.walkAtRules("media", (rule) => {
    if (/,|\bor\b|\bnot\b|\bonly\b/u.test(rule.params)) return;
    const parts = rule.params.split(/\s*\band\b\s*/u).map((part) => part.trim()).filter(Boolean);
    const verdicts = parts.map((part) => widthCondition(part, width));
    if (verdicts.every((verdict) => verdict === null)) return;
    if (verdicts.includes(false)) return void rule.remove();
    const rest = parts.filter((_, index) => verdicts[index] === null);
    if (rest.length) rule.params = rest.join(" and ");
    else rule.replaceWith(rule.nodes);
  });
  return root.toString();
}

/** Builds the app into `<extensionRoot>/app`, and its public files into `extensionRoot`. */
export async function buildApp({ extensionRoot, release, hubUrl, minify = true }) {
  const settings = { minify, release, hubUrl };
  const out = path.join(extensionRoot, APP_DIRECTORY);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const [scripts, css] = await Promise.all([buildScripts(out, settings), buildStyles(out, minify), buildDocumentScript(out, settings)]);
  fs.writeFileSync(path.join(out, "index.html"), PAGE);
  fs.writeFileSync(path.join(out, "ask.html"), ASK_PAGE);
  const built = fs.readdirSync(out).filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(out, name), "utf8"));
  copyPublicFiles(extensionRoot, [...built, css]);
  return { out, ...scripts };
}
