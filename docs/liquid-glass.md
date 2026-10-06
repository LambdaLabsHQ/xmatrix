# Liquid glass — implementation notes & lessons

The app defaults to light appearance, regardless of the system appearance. Web
HTML declares the Wood material and light color scheme before scripts run. Native
iOS, Android, and desktop shells use the Wood paper background (`#f5efe5`) while
pages load; native controls also use light appearance. Android API 26 retains a
dark system navigation bar for its white icons; API 27+ uses the light paper bar.

The `/app` web UI and the public site render Apple's iOS 26 **Liquid Glass**
(regular variant, light appearance). The values are measured, not guessed:
from Apple's iOS 26 Messages screenshots on Apple Newsroom (June 2025), at
1.736 image px per pt, where 1pt is 1 CSS px:

1. **Lens** — the signature. Only the outer 8px of the glass bends, by
   `18 · (1 − d/8)²` px toward the centre, so content just inside the rim
   folds out to the edge as a thin mirrored arc, apart from the content
   itself. Fitted against the Phone app's search button in Apple's
   screenshot, where the blue call glyph underneath appears both softened
   in place and as a crisp arc hugging the rim. A Snell squircle (kube.io)
   collapses that band into one pixel; a circle profile magnifies the whole
   disc.
2. **Material** — the regular variant "blurs and adjusts the luminosity" of
   what is behind it (HIG, Materials). The chain is `blur(2px)`, then the
   lens, then `saturate(1.5)`: the lens bends the already-softened backdrop,
   so what it squeezes into the rim comes out crisp, as in iOS. The fill is a
   light grey veil (`oklch(0.97 0 0 / 0.4)`): the iMessage field reads
   252/255 on white, and colour under the glass stays vivid. Apple's regular
   glass lets "as much of the content through as possible" while keeping
   what sits on it legible, so glass on the wood planks takes the
   `LIQUID_GLASS_ON_WOOD` parameters (a whiter but thinner veil, white at
   .45, a 1pt blur, saturation 1.2, a `0 1px 4px` shadow at .1): the grain
   shows, bent by the same lens as the composer's. The rail's selection and
   avatar take `LIQUID_GLASS_ON_WOOD_RAIL`, the same glass with a .25 veil:
   they sit on bare grain and read better more see-through.
3. **Rim** — there is no border. Apple's glass "has no inherent color, and
   instead takes on colors from the content directly behind it" (HIG,
   Color), and lensing "bends, shapes, and concentrates light" (WWDC25, Meet
   Liquid Glass). So the lens also screens the backdrop toward white along a
   1pt rim (`--app-liquid-edge-light`, .65): brightest where the edge faces a
   light at the top left, weaker on the bottom right, almost nothing on the
   sides between. Over wood the rim is a paler wood; over white it vanishes.
   Measured on Apple's own renders (macOS widgets, the tvOS clock over warm
   sand), the lit edge moves the backdrop 30–45% toward white and the sides
   not at all; ours measures about 30% on the lit edges, 50% at the top-left
   peak and 10% at the bottom. Where there is no lens, a faint 1px glint on
   the lit sides (white at .14 top-left, .06 bottom-right) is all that
   remains. Nothing inside the rim: no inner glow, shade or gradient.
4. **Shadow** — soft and heavier below. Under the 40pt back button the page
   darkens by 27 levels at the edge and 15 at 20px, but only 7 above;
   `0 10px 30px` at .2 reproduces that within 2 levels. Apple lightens the
   shadow over a solid light background, and the composer controls in the
   same screenshot carry about .14, which is the shared value. Chips and
   avatar discs cast a third of it (`0 3px 10px`) and bend through a
   thinner lens (5px bezel, 8px offset), because Apple scales the shadow and
   the lens with the size of the glass.

Pressing a glass control swells it (`scale: 1.07`) on a springy curve and
lights it from within, as on iOS. Content surfaces (cards, the composer) do
not move.

Apple's guidance to keep in mind: glass is for controls and navigation, not
the content layer; never glass on glass; use it sparingly.

Reference technique for the lens: [kube.io — Liquid Glass with CSS & SVG](https://kube.io/blog/liquid-glass-css-svg/)
(convex squircle surface, Snell refraction at n = 1.5).

## Mental model

Liquid glass is **one recipe, reused everywhere**. The same look must appear on
the sidebar active pill, the workspace switcher, channel detail cards, ABILITIES
buttons, the composer, detail cards, and popovers — throughout the Wood
application material. There is no per-component glass; there is one material
that all of them opt into.

Liquid glass is also **one surface layer**. Do not put liquid glass on top of
liquid glass: no glass buttons, cards, docks, popovers, or backdrop-filter glass
inside another liquid glass surface. Inner controls should use solid, tinted, or
outline styling so the backdrop filter never stacks.

## Semantic material components

On iOS, the system Dock's visible glass capsule stays horizontally centered,
including when UIKit limits its width or relayouts its platter. The native
bridge reports the capsule's measured right inset as `--app-native-dock-inset`;
the Web create button uses that inset directly and keeps 12px above the Dock.
Older shells without this measurement use the centered Web Dock's right edge.

On phones, the workspace bar is a continuous wood board from the physical top
of the screen, including the status-bar safe area, to its straight bottom edge.
Workspace and channel bars share a 60px title row plus the top safe area,
with no border or shadow. A channel Summary sits on paper below the bar
without a separate card or side margins. Conversation, page, and
tool list rows extend to both screen edges. Their content and the workspace
bar's glyphs share `--mobile-content-inset`, the Dock inset plus 20px, while
the Dock and create button retain their floating geometry. Desktop geometry
is unchanged.

Page code must choose material and geometry explicitly through
[`material-surfaces.tsx`](../apps/web/src/components/ui/material-surfaces.tsx):

- `WoodPanel` is the continuous page or rail substrate.
- `LiquidGlassCard` is a bounded, non-interactive content surface on wood. It
  has a fixed card radius and must never become a capsule as its aspect ratio
  changes.
- `LiquidGlassPill` is the same fill recipe as `LiquidGlassCard`, reserved for
  compact controls whose height is intentionally pill-shaped. Geometry is the
  only difference (`border-radius: 999px` vs `20px`). Sidebar selected-channel
  rows may apply a compositor-safe exception, but that exception is scoped to
  `.app-channel-row` / `.app-sidebar-glass-item`, never to the pill primitive.
- `MaterialChip` is a small solid/tinted label. It is deliberately not liquid
  glass, so it can safely appear inside a glass card or pill.

Reuse these components; do not respell their classes. Tags (`Tag`), avatar
discs (`IdentityAvatar`) and the selected rail button render through
`LiquidGlassPill`, the composer buttons' own primitive, so they share its
blur, lens and saturation. Raw class strings miss the lens, and a glass
surface without `app-material-liquid-pill` is frosted at 24px in the mobile
shell. An avatar that already sits inside glass (the agent discs above the
composer) passes `glass={false}`.

Glass on a wood plank (the details cards) bends the real plank behind it. The
plank pours its grain in through inheritable tokens, so `globals.css` resets
them on glass inside the plank; never let a chip paint a copy of the grain.

Do not use `rounded-*`, `bg-*`, or a page-specific selector to infer a material.
Those utilities may adjust layout, but the semantic component owns the physical
surface and its radius. New page-level material exceptions should be treated as
a missing shared primitive, not added as another cascade override.

The effect is built in two layers:

1. **Runtime lens** —
   [`apps/web/src/components/ui/liquid-glass-lens.tsx`](../apps/web/src/components/ui/liquid-glass-lens.tsx).
   `LiquidGlassSurface` with `fill` opts in through `useLiquidGlassLens`; one
   shared `ResizeObserver` reports border-box sizes, and the module draws a
   displacement map for each (size snapped to a quarter pixel, radius, bezel) key and
   sets `--app-liquid-lens: url("#xm-lens-…")` on the element.
   `LiquidGlassLensDefs`, mounted once in the root layout, renders the
   `<filter>`s. Bounds: no document scans or MutationObserver, maps capped at
   48k pixels (stretched onto the surface), identical keys share one filter,
   a filter is dropped with its last surface, at most 64 filters exist (later
   surfaces keep the CSS recipe), at most 4 maps are drawn per frame, and
   surfaces under 16px on either side get no lens.
   - Chromium and Electron only: other engines do not accept an SVG `url()`
     in `backdrop-filter`, so Safari (including the iOS app's WKWebView) and
     Firefox get layers 2–4 without the lens.
   - A surface whose computed `backdrop-filter` is `none` (glass on a slab,
     white controls on the paper) never holds a lens.

2. **CSS material recipe** —
   [`apps/web/src/app/liquid-glass.css`](../apps/web/src/app/liquid-glass.css).
   Holds the shared tokens (`--app-liquid-*`) and the `.app-liquid-glass-fill`
   rules. The backdrop chain is `var(--app-liquid-backdrop-filter,
   var(--app-liquid-material) var(--app-liquid-lens,) var(--app-liquid-vibrancy))`;
   a surface that sets its own `--app-liquid-backdrop-filter` keeps the lens
   between the blur and the saturation, declared on the element itself so the
   per-element lens resolves. The edge is `--app-liquid-edge-meniscus`
   (→ `--app-glass-edge`). Themes set **values only**; structure lives here.

Unification is enforced by a high-specificity override block in
[`apps/web/src/app/globals.css`](../apps/web/src/app/globals.css) that forces
every glass selector onto the shared tokens, so cards/pills/composer can't
diverge through inherited theme/slab vars.

## How to verify a change (this is not optional)

Playwright's Chromium renders the lens (its UA says `HeadlessChrome`, which the
engine check accepts). On flat paper the lens is invisible by nature, so judge
it over a high-contrast backdrop: paint stripes on the element behind the
composer (`document.elementsFromPoint` just above it) in a throwaway spec.

Checklist when verifying:

- **Confirm the displacement is actually applied**, don't trust the visual:
  ```js
  document.querySelectorAll('filter[id^="xm-lens"] feImage').length  // > 0
  getComputedStyle(el).backdropFilter   // 'blur(2px) url("#xm-lens-…") saturate(1.5)'
  ```
  If it has no `url("#xm-lens-…")`, the lens is **not** applied.
- **Verify at realistic retina scale**, not 5–6× zoom. Zooming hid a regression
  once: crescents looked correct zoomed but were invisible at real device scale.
  Use device-scale 2 and magnify with page `zoom` only to *inspect*, then judge
  at 1×.
- **Screenshot the Wood material**. It is the fixed application material; no
  theme preference is persisted or selectable.
- Refraction on a low-contrast backdrop (flat wood grain) is **subtle by
  design** — Apple's reference had high-contrast album art. Don't crank the
  effect to make it pop on grain; check edge-bending at the bezel instead.

## Lessons learned (the expensive ones)

1. **An unbounded per-element filter froze Chromium.** The first lens scanned
   the whole document with a MutationObserver, measured every glass surface
   synchronously, drew two full-size PNG maps for every distinct size, and
   kept them forever. Responsive size churn made cache and compositor work
   unbounded; a modest group of surfaces could block Chromium (and Electron)
   for minutes. The current lens is opt-in per surface, reads sizes from one
   ResizeObserver, rounds and shares keys, caps map pixels, filter count and
   maps per frame, and frees a filter with its last surface. Keep every new
   cost behind one of those bounds.

2. **One source per layer.** Refraction and the rim's concentrated light
   come only from the lens; the no-lens glint and the shadow come only from
   `--app-liquid-edge-meniscus`. A white ring around the whole edge reads as
   a drawn border on wood, which was rejected twice. The glass
   once looked "heavy" because an SVG specular map, a CSS rim and CSS caustics
   all painted the edge. If glass looks wrong, check what is double-painting
   before touching the lens math. Per-surface `--app-glass-edge` overrides
   (the composer once had three) are how surfaces drift apart.

3. **Frost is not iOS.** Heavy blur (12–22px) with a thin fill looks like
   frosted plastic, and white edge effects on a thin fill read as a drawn
   border (a 1px ring plus blurred 1.5px crescents plus a 12px inner shade
   was rejected as too thick). iOS keeps the blur near 1pt and lifts
   luminosity instead, so the rim is only a glint against the shadow.

4. **Watch for "zombie" cascade rules.** `html` is always `.light` (no dark
   mode), so legacy `:root:not(.dark)` / `.light` and theme-specific overrides
   silently win over the unified recipe. A `wood`-only `backdrop-filter:
   blur(3.5px)` override was defeating the displacement on fill cards. When a
   surface won't take the recipe, grep for a higher-specificity theme/light rule
   re-setting `background` / `backdrop-filter` / `box-shadow`.

5. **Signed, not absolute, displacement.** Using `abs(magnitude)` for the
   refraction sample collapses concave/lip profiles into inward-only bending.
   Keep the sign; normalize by `max(abs)`.

6. **The unification override is `(0,15,1)` specific — count the `:not()`s.**
   The single-source override in `globals.css` ends with ~8 trailing
   `:not(.x)` exclusions, and **each one adds `(0,1,0)`**. So beating it (e.g.
   to make the workspace switcher flat at rest) needs a selector that *exceeds*
   `(0,15,1)`, not just "looks more specific." The cheap, readable way is to
   mirror the same `:not()` exclusion chain plus one extra class. When an
   override "should win" by the usual rules but doesn't, recount including
   every `:not()` before assuming `@layer` or HMR. (It is *not* `@layer` here —
   these rules are all unlayered.)

7. **CI gates on jscpd for CSS.** Duplicated CSS blocks fail the build:
   `pnpm check:duplicates` (zero clones across program source, tests and workflows;
   generated output and historical migrations are excluded). When
   repeating a selector list or recipe, factor it (shared token, extracted
   loop) rather than copy-pasting. Run it before pushing.

8. **Never run `next build` / `PNPM build` / dev against the running dev
   server.** It corrupts the live `.next` (ENOENT build-manifest, blank app).
   Recovery: kill `:3001`, `rm -rf apps/web/.next`, restart the dev server.
   For verification, typecheck (`pnpm --filter @xmatrix/web typecheck`) +
   `pnpm check:duplicates` + Chrome MCP — no build.

9. **Do not bind compositor exceptions to the primitive class.**
   Card and pill are one fill (`liquid-glass.css`) and two radii. Sidebar
   rows that sit on the wood slab opt out of *nested backdrop-filter only*
   via `.app-glass-on-slab` or `.app-sidebar .app-channel-row` — they keep
   the same `--app-liquid-surface-bg` and rim. A previous `materials.css`
   fill on `.app-material-liquid-pill` made the first public-site reuse
   (DMG/ZIP) look like a frosted beige stadium while the download icon
   (a card) was correct.

10. **Glass edges must line up to the pixel.** Two dirty edges on wood came
    from misalignment, not from the recipe. A lens map rounded up to 4px
    (132px for a 129px chip) left the chip's right cap unbent, showing the
    dull blurred edge; maps now snap to a quarter pixel. And Chromium snaps
    a backdrop-filter's region to whole pixels while the fill is painted at
    the true edge, so a 19.7px-tall chip showed a 1px strip of unveiled,
    saturated wood along its bottom; chips now have a whole-pixel line
    height. Measure both caps and the bottom row before blaming the lens.

## Tuning knobs

The glass is one parameterized material. `LiquidGlassMaterial`
([`liquid-glass-material.ts`](../apps/web/src/components/ui/liquid-glass-material.ts))
names its fields — `veil`, `blur`, `saturation`, `refraction`, `bezel`,
`edgeLight`, `shadow` — and maps each onto the tokens below. Set it on one
surface with the `material` prop of `LiquidGlassSurface`, `LiquidGlassPill` or
`LiquidGlassCard`, or on a container with `liquidGlassMaterialStyle(...)` so
every surface inside takes it (the details panels apply
`LIQUID_GLASS_ON_WOOD` this way, the rail `LIQUID_GLASS_ON_WOOD_RAIL`). Unset
fields follow the context, then the recipe defaults. In development,
`/dev/glass-lab` renders a wood plank, the rail and paper with rows of real
tags, with a slider per field (the rail's veil on its own) and the resulting
`LiquidGlassMaterial` to paste; query parameters seed it, for example
`/dev/glass-lab?veil=0.6&railVeil=0.25&saturation=1.1&shadow=1,4,0.1`.

The defaults live in [`liquid-glass.css`](../apps/web/src/app/liquid-glass.css):

| Token | Effect |
| --- | --- |
| `--app-liquid-shared-surface-bg` | grey veil; iOS reads 252/255 on white |
| `--app-liquid-material` | blur before the lens (2px) |
| `--app-liquid-vibrancy` | saturation after the lens |
| `--app-liquid-bezel-width` | lens bezel width (px) |
| `--app-liquid-glass-thickness` | largest lens offset (px) at the rim |
| `--app-liquid-refraction-level` | multiplies the lens offset |
| `--app-liquid-edge-light` | how far the lens screens the rim toward white (peak, top-left) |
| `--app-liquid-specular-lead` / `-trail` | the no-lens glint on the top-left / bottom-right 1px band |
| `--app-liquid-shadow` / `-small` | the shadow under glass, `0 10px 30px` at .14; chips and avatars a third of it |
| `--app-liquid-float-shadow` | the default shadows' strength |

To re-check against iOS, render a surface at `deviceScaleFactor: 1.736`
beside a crop of an Apple screenshot and compare pixel columns through the
rim and shadow.

The lens reads the bezel, thickness and refraction tokens from each surface's
computed style; the defaults in `liquid-glass-lens.tsx` mirror the CSS.
