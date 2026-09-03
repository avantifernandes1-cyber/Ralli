# Ralli Typography & Visual System (foundation)

Status: **foundation established** (this pass). The Ralli Live leaderboard podium is the visual
benchmark — clear hierarchy, restrained depth, soft layered surfaces, subtle gradients, strong
spacing, purposeful gold accents, refined hover/focus, minimal decorative emoji. This document is the
single reference for the typography system and the direction for the broader visual system. It is a
foundation, **not** a full redesign of every screen.

## 1. Typography hierarchy

| Role | Font | Where |
|---|---|---|
| Display / page title | **Unbounded** | Home/screen titles, org titles, Settings, "ralli games" |
| Section title | **Unbounded** | Section headings that head a block |
| Card / modal / drawer title | **Unbounded** | Titles that function as headings |
| Empty‑state title, major result/celebration heading | **Unbounded** | e.g. leaderboard podium ranks/accuracy |
| Subtitle / description / paragraph / instructional copy | **Outfit** | supporting text |
| Navigation, buttons, links, inputs, form labels | **Outfit** | all controls |
| Table headings & cells, filter labels, dropdowns, tooltips | **Outfit** | data + controls |
| Badges / status labels; metric **labels** | **Outfit** | supporting labels |
| Metric **values** that are intentionally display type | **Unbounded** | e.g. podium accuracy % |
| Quiz questions & answers, lesson/course content, Battle Card body, user rich text | **Outfit** | content, never display |

Unbounded is a wide display face; it is used to create hierarchy, **not** applied to every small
uppercase label or table header (those stay Outfit for readability). `h3` intentionally stays Outfit,
because many `h3`s in this app are small section labels rather than display headings.

## 2. Font loading & stacks (single source of truth)

Fonts load **once** from `index.html` (`display=swap`; safe system fallbacks). No component injects a
font at runtime (a prior `Plus Jakarta Sans` runtime override of `document.body` was removed).

- `--font-heading: 'Unbounded', 'Outfit', -apple-system, …, sans-serif`
- `--font-body: 'Outfit', -apple-system, …, sans-serif`
- Weights requested (all actually used): **Outfit** 400/500/600/700/800/900; **Unbounded** 500/600/700/800/900.
- `font-synthesis-weight: none` (never fake‑bold a missing weight).

Global rules in `index.html`:
- `body { font-family: var(--font-body) }` — everything defaults to Outfit.
- `h1, h2 { font-family: var(--font-heading); line-height:1.15; letter-spacing:-0.01em }` — display headings.
- `.rl-content` (and its heading descendants) → forced back to Outfit for content that is marked up as a heading (e.g. the Ralli Live quiz‑question `<h2>`).

## 3. Using the system

- **Semantic classes** (in `index.html`): `.ty-display`, `.ty-page-title`, `.ty-section-title`,
  `.ty-card-title`, `.ty-modal-title`, `.ty-empty-title` (Unbounded); `.ty-subtitle`, `.ty-body`,
  `.ty-caption`, `.ty-label`, `.ty-control`, `.ty-metric`. Display/page titles use `clamp()` for
  restrained responsive sizing.
- **JS tokens** (`TYPO` in `rankd-app.jsx`, mirrors the classes): spread into inline styles for
  div‑based titles/metrics. `TYPO.headingFont` / `TYPO.bodyFont` are the raw stacks (CSS vars).
- **Do**: prefer a token/class/var over a hard‑coded family string. **Don't**: hard‑code `'Unbounded'`
  or any raw family; don't apply Unbounded to small labels/table headers; don't restyle user rich text.

## 4. Accessibility (respected in this foundation)

- Keyboard focus: a restrained `:focus-visible` ring for interactive elements that lack one
  (zero‑specificity `:where()` so component styles still win).
- `@media (prefers-reduced-motion: reduce)` neutralizes animations/transitions globally.
- Fallback stacks keep text readable if a web font fails; auth and the error boundary render in the
  fallback (they reference `var(--font-body)`, always defined in `index.html`).
- Headings can wrap (no `nowrap`/`overflow:hidden` baked into the shared heading rule).
- Contrast, 200% zoom, and no‑color‑only signalling are validated in visual QA.

## 5. Visual‑system direction (documented; not overhauled here)

The following are the agreed direction, to be applied incrementally in later passes (the leaderboard
podium is the reference, **not** a mandate that every card become a podium or use gradients):

- Subtle surface hierarchy (soft layered surfaces over flat white cards).
- Restrained **gold** accent (`--primary #FDBF24`) used purposefully, not everywhere.
- Soft, layered shadows; consistent corner radii (existing `radiusSm/Md/Lg` = 8/12/20).
- Premium selected/active states; refined hover/focus.
- **Designed icons** instead of decorative emojis (emojis remain only where intentional/simple).
- Subtle motion with reduced‑motion support.
- Stronger, accessible data visualization; accessible contrast + visible focus everywhere.

## 6. Scope of this pass / deferred

Covered now: canonical font system (loading, tokens, classes), Outfit as the true body across the app
(removing the Plus Jakarta override + Inter conflicts), Unbounded on `h1/h2` display headings
platform‑wide (auth, dashboards, Learn, quizzes, Ralli Live, Battle Cards, Settings/org, marketing —
all share the same global rules), content protection for quiz/lesson/rich‑text, accessibility
(focus + reduced‑motion), and guard tests.

Deferred (intentionally, to avoid a redesign in one pass): promoting selected larger `h3`/div‑based
section titles to Unbounded via `.ty-section-title` where it improves hierarchy; per‑surface spacing,
shadow, radius, and icon refinement; the broader visual‑system rollout above; and any
Leadership‑Dashboard/readiness work (out of scope).
