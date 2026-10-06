# Web CSS architecture

The web app's styles are being rebuilt from one global stylesheet into
component-owned Tailwind v4 styles. This document is the target and the rules
every stylesheet change follows; `globals.css` still holds most rules until
the migration below finishes.

## Why

`globals.css` grew to over 10,000 lines that styled components from the
outside: rules keyed on class names with no link to the component that renders
them, rules that rewrite Tailwind utilities (`.rounded-md.border`,
`.bg-popover`, `text-amber-*`) wherever they appear, and a cascade decided by
`!important` and repeated `.xmatrix-app` classes rather than by layers. The
Billing segmented control, a few lines of classes in its component, matched
about 25 rules from six places. No tool could say which rule belongs to which
component, so dead rules piled up and every change risked an unrelated screen.

## Target

- **Tokens** live in `src/app/tokens.css`: one rule each for the document
  (`:root`), the body canvas (`.site-canvas`, where portaled overlays render)
  and the app shell (`.xmatrix-app`), which inherits every canvas value it does
  not set. Wood is the only theme: `<html>` is always `.light` with
  `data-app-theme="wood"` and never `.dark`, so no rule is prefixed by a theme.
- **Component styles** are Tailwind utilities on the component's own elements,
  with variants through `cva` (as the `ui/` components do). States use
  Tailwind variants (`hover:`, `aria-selected:`, `data-[state=open]:`,
  `max-md:`); a context the component must react to is a prop, not an ancestor
  selector written somewhere else.
- **Shared materials** (liquid glass, wood planks, chips, list rows) are written
  once, as `@utility` recipes or as shared React components
  (`LiquidGlassSurface`), and components opt in by using them. Nothing applies
  a material by sweeping the page with a selector.
- **Element defaults** (typography, form controls, focus rings) are in
  `@layer base`.
- **The cascade is the layer order** Tailwind defines (`theme`, `base`,
  `components`, `utilities`). No `!important`, no repeated classes to win on
  specificity, no rule that restyles a Tailwind utility.

## Migration

The order is top-down, because a rule that reaches every element (`.xmatrix-app *`)
or every element of a shape (`.rounded-lg.border`) affects components that
cannot be migrated while it stands:

1. Tokens into `tokens.css` (done).
2. Universal and element rules into `@layer base`.
3. Shape rules that rewrite Tailwind utilities, replaced by explicit classes on
   the components they actually reach.
4. Component by component, starting with the largest owners (message timeline,
   shell chrome, composer, sidebar).
5. A stylelint gate for the rules above, at zero violations.

## Proving a change is a no-op

Every step must leave the rendered app unchanged. With `CSS_DUMP_DIR` set, each
web e2e test records every element's computed style, including `::before` and
`::after`, with transitions and animations stopped (`e2e/computed-style-dump.ts`).
Run the suite twice on `main` and twice on the change, then:

```sh
node scripts/css-computed-diff.mjs <main-1> <main-2> <change-1> <change-2>
```

An element counts as changed only when both `main` runs agree, both change runs
agree, and the two builds disagree, which separates real changes from pages
that are not deterministic. States the e2e suite does not reach (hover, rare
dialogs, plan cards) still need before and after screenshots.
