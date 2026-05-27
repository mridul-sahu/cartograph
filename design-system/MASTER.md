# Cartograph — Design System

> **Logic:** when building a specific page, first check `design-system/pages/<page>.md`.
> If that file exists, its rules **override** this Master file.
> If not, follow the rules below.

Synthesized via `ui-ux-pro-max` skill (2026-05-24), then tuned to cartograph's
brutalist personality and the explicit "knowledge dashboard, not marketing
site" constraint.

---

## 0. Identity (load-bearing)

Cartograph is a **single-author knowledge dashboard** for one person navigating
five hard codebases. It is read all day by the same eye that wrote it. That
shapes every choice below:

- **Density beats whitespace.** Information per square inch is the metric. We
  are not selling anything; we are not converting anyone.
- **Personality stays brutalist.** Sharp corners, visible borders, monospace
  for data, offset shadows. Skill recommendations that drift toward generic
  SaaS (`border-radius: 12px`, soft drop-shadows, gradient hero) are rejected.
- **Editorial grid for reading.** Long-form pages (topic notes, papers,
  research, designs) use a constrained measure (60–75ch) inside an asymmetric
  grid with a sticky right sidebar for metadata + TOC.
- **Data-dense grid for indexes.** Listing pages (designs, episodes, setups,
  research, papers) pack 2–3 cards per row at lg+, no per-section paragraph.

---

## 1. Color tokens

CSS variables live in `web/src/styles/global.css`. Light is the default;
`html[data-theme="dark"]` swaps the values. Never hardcode a hex in
component code — use the var.

### Light

| Token            | Hex        | Role                                                |
|------------------|------------|-----------------------------------------------------|
| `--bg`           | `#fafaf7`  | Page surface 0                                       |
| `--surface-1`    | `#f3f3ef`  | Slightly raised inline / chip / muted strip         |
| `--surface-2`    | `#ffffff`  | Brutal-card body (raised, with shadow)              |
| `--fg`           | `#0a0a0a`  | Primary text                                         |
| `--fg-muted`     | `#374151`  | Secondary body text                                  |
| `--fg-subtle`    | `#6b7280`  | Meta (counts, dates, tags)                          |
| `--border`       | `#0a0a0a`  | Brutal hard border                                   |
| `--border-soft`  | `#d4d4d0`  | Inline divider, table cell border                   |
| `--accent`       | `#1e40af`  | Links, focus, active state                          |
| `--accent-fg`    | `#ffffff`  | Text on accent fill                                  |
| `--ok`           | `#166534`  | Present / success                                    |
| `--warn`         | `#b45309`  | Drift / superseded / partial                         |
| `--danger`       | `#b91c1c`  | Missing / rejected                                   |

### Dark — same roles, inverted lightness; ratios held ≥ 4.5:1.

`--bg` `#0a0a0a` · `--surface-1` `#1a1a1a` · `--surface-2` `#161616` ·
`--fg` `#fafaf7` · `--fg-muted` `#d1d5db` · `--fg-subtle` `#9ca3af` ·
`--border` `#fafaf7` · `--border-soft` `#3f3f3f` · `--accent` `#60a5fa`.

**Don't introduce new colors.** Five status hues is the cap. If a new state
needs a colour, pick the closest existing one and use a chip variant
(filled / outline / dot).

---

## 2. Typography

Three families, no more.

| Family            | Usage                                                       |
|-------------------|-------------------------------------------------------------|
| `Inter`           | UI body (paragraphs, labels, button text). 400 / 500 / 700. |
| `JetBrains Mono`  | Code, file paths, frontmatter values, counts, chip text.    |
| `VT323`           | The wordmark **only**. Never used in body text.             |

**Scale** (use these classes; don't invent new sizes):

| Class           | px   | Usage                                  |
|-----------------|------|----------------------------------------|
| `text-7xl`      | 72   | Wordmark hero only                     |
| `text-5xl/6xl`  | 48/60| Page H1 on index pages                 |
| `text-3xl/4xl`  | 30/36| Detail-page H1                         |
| `text-2xl`      | 24   | Section title                          |
| `text-lg`       | 18   | Card title                             |
| `text-base`     | 16   | Body                                   |
| `text-sm`       | 14   | Compact body, secondary card title     |
| `text-xs`       | 12   | Eyebrow, mono meta, chip               |
| `text-[10px]`   | 10   | Tag chip, uppercase tracker            |

`letter-spacing: -0.02em` on headings (`tracking-tightish`).
`line-height: 1.6` on body paragraphs; `1.15` on headings; `1.7` on
`.prose-cartograph` long-form.

---

## 3. Spacing scale

Stay on the Tailwind 4px grid. Use these step values; do not interpolate.

| Gap kind                  | Class      | Use                                       |
|---------------------------|------------|-------------------------------------------|
| Inline icon/chip gap      | `gap-1.5`  | Chip rows, inline metadata                |
| Card padding (compact)    | `p-3`      | Filter chip rows, ToC                     |
| Card padding (default)    | `p-4`      | List item card                            |
| Card padding (article)    | `p-6`      | README render, prose surfaces             |
| Section vertical          | `mb-10`    | Between every top-level section           |
| Page top                  | `py-8`     | `<main>` (was `py-10`)                    |

The site currently uses `mb-14 / mb-12 / mb-10` interchangeably. New rule:
**every section uses `mb-10`**. Tighten the inconsistent ones as touched.

---

## 4. Surfaces

| Class                | Border           | Shadow            | Background       | Use                                              |
|----------------------|------------------|-------------------|------------------|--------------------------------------------------|
| `brutal-card`        | 2px hard         | `6px 6px 0`       | `--bg`           | Primary content card (default)                   |
| `brutal-card-flat`   | 2px hard         | none              | `--bg`           | Nested card, inline sub-card, sidebar block      |
| `brutal-card-soft`   | none             | none              | `--surface-1`    | Tertiary surface (search results row, meta strip)|

`brutal-card` is the only one with the shadow — keep the brutalist signal
rare so it actually signals. Don't nest two shadowed cards.

**Hover idiom for cards that link:**
```css
cursor: pointer;
transition: transform 120ms ease-out, box-shadow 120ms ease-out;
/* on hover */
transform: translate(-2px, -2px);
box-shadow: 8px 8px 0 0 var(--shadow);
```

Never scale, never rotate.

---

## 5. Chips

The chip is the workhorse status indicator. Four variants by tone, two sizes.

```html
<!-- default tonal (neutral) -->
<span class="chip">tag</span>
<!-- status -->
<span class="chip chip-ok">present</span>
<span class="chip chip-warn">superseded</span>
<span class="chip chip-danger">missing</span>
<span class="chip chip-accent">docx</span>
<!-- size -->
<span class="chip chip-sm">1.4k words</span>
```

Rules:
- Chip text is **always lowercase**.
- Chip never wraps internally.
- A row of chips uses `flex flex-wrap gap-1.5`.

---

## 6. Layout patterns

### 6a. Hero + section TOC (repo dashboard, index pages with many sections)

```
+-----------------------------------------------------------+
| H1  [status chips]  [primary actions]                     |
+-----------------------------------------------------------+
| ON THIS PAGE: bedrock 3 · topics 11 · designs 2 · …       |
+-----------------------------------------------------------+
| Section 1
| Section 2
| ...
```

Already implemented on `/repo/[repo]/`. Extend to dashboards that have ≥ 4
sections.

### 6b. Index page — grid

```
[index hero — H1 + one-line context]
[grid: lg:grid-cols-2 xl:grid-cols-3 (data-dense)]
```

Apply to: `/designs/`, `/setups/`, `/research/`, `/papers/`, `/walkthroughs/`,
`/sessions/`, `/promotions/`. Cards inside the grid are `brutal-card p-4`.

### 6c. Detail page — article + sticky sidebar

```
+---------------------------+-------------------+
| article (max 70ch)        | sticky sidebar    |
| · prose                   |  · TOC            |
| · code blocks             |  · frontmatter    |
|                           |  · actions        |
+---------------------------+-------------------+
```

`/papers/[repo]/[slug]/` already has this. Apply to `/designs/[repo]/[slug]/`,
`/research/[repo]/[slug]/`, `/repo/[repo]/topics/[topic]/` in a follow-up.

### 6d. Reading content — `prose-cartograph` constrained measure

Body text limited to `max-width: 70ch`. Headings get their own border-bottom
divider. Already wired in `global.css`.

---

## 7. Interaction rules (skill-mandated, must pass)

- **All clickable elements** carry `cursor: pointer` (already on `.brutal-button`;
  ensure on all `<a class="brutal-card">`).
- **Hover transitions** are 120–200ms (existing rule, brutalist).
- **Focus rings** visible — `:focus-visible { outline: 2px solid var(--accent); offset 2px }`.
  Test by tabbing through the nav.
- **`prefers-reduced-motion`** respected (global override in `global.css`
  zeros all transition/animation durations).
- **No emojis as icons.** SVGs only. The site currently uses Unicode arrows
  (`→`, `↗`, `▾`) — acceptable as type, not as semantic icons.
- **Touch target ≥ 44px** for nav links and dropdown items on mobile.

---

## 8. Anti-patterns (do not introduce)

- ❌ `border-radius` > 0 anywhere (the skill suggested `12px` cards — rejected).
- ❌ Soft blur shadows (`box-shadow: 0 10px 30px rgba(0,0,0,0.1)`). Only the
  hard 6px-offset shadow on `brutal-card`.
- ❌ Gradient fills (skill suggested cool→hot gradients for the dashboard
  pattern — rejected; we use explicit chips).
- ❌ Hero CTAs and "Sign up" patterns from the landing-page advice. None of
  the pages convert anything.
- ❌ Emoji icons. SVG only.
- ❌ Hover transforms larger than 2px (no scale, no rotation).
- ❌ Stacking shadowed cards. One shadow per visual layer.
- ❌ New top-level nav items. Use the `more ▾` dropdown.

---

## 9. Pre-delivery checklist (per page)

- [ ] No emojis used as icons (SVG / Unicode arrow only)
- [ ] All clickable cards have `cursor-pointer` (via `brutal-card` hover rule)
- [ ] Section headings cite count + path (`right=` on `SectionTitle`)
- [ ] Light + dark mode tested (`html[data-theme="dark"]` overrides hold)
- [ ] No `text-muted` paragraphs longer than 2 lines (compress or chip-row it)
- [ ] No section description paragraphs at all on index pages (the H1 + grid
      is self-explanatory)
- [ ] Long lists use the grid pattern (6b), not the single-column stack
- [ ] Focus ring tested by Tab — visible on every interactive element

---

## 10. Source provenance

| Source                          | Pulled                                                     |
|---------------------------------|------------------------------------------------------------|
| ui-ux-pro-max `--design-system` | accessibility / interaction floor, anti-pattern list       |
| ui-ux-pro-max `style` domain    | Brutalism + Editorial Grid + Data-Dense Dashboard          |
| ui-ux-pro-max `typography`      | Developer Mono pairing (JetBrains Mono + IBM Plex Sans).  |
|                                 | Cartograph diverges: Inter instead of IBM Plex (already    |
|                                 | loaded; one fewer family to ship).                         |
| Existing `global.css`           | Palette, brutalist primitives, prose-cartograph            |
| Per-project deviation           | All deviations from the skill defaults are listed in §8.   |
