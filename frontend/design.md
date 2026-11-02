# open·kritt console — design system

Locked by the Hallmark redesign. Every screen reads this file; no page invents its
own palette, scale or chrome.

## The idea

The console is a **ledger**. The product's object is a scan moving through a
workflow; the interface shows that object as dense rows, tabular figures and one
coral mark for the live run. Coral is the brand and the only signal: primary
action, live state, current selection. Everything else is warm ink on warm paper.

Utilitarian, not decorative. A fluent operator should trust the screen in one
glance and never see an ornament.

## Tokens

All colour lives in `src/tokens.css`; all scale in the same file. Never write a
hex, `rgb()`, `oklch()` literal or a raw font family outside that file.

| Role               | Token                                     | Use                                  |
| ------------------ | ----------------------------------------- | ------------------------------------ |
| Page background    | `--bg`                                    | the scroll surface                   |
| Card / row surface | `--surface`                               | panels, table body                   |
| Recessed surface   | `--surface-2`                             | table heads, code, quiet fills       |
| Third surface      | `--surface-3`                             | progress tracks                      |
| Hairlines          | `--border`, `--border-2`                  | 1px only                             |
| Ink                | `--text`                                  | body and headings                    |
| Secondary ink      | `--text-2`                                | descriptions, meta                   |
| Tertiary ink       | `--text-3`                                | timestamps, hints (never below 11px) |
| Accent             | `--accent`                                | primary button fill, live marker     |
| Accent ink         | `--accent-strong`                         | links, accent text (passes 4.5:1)    |
| Accent foreground  | `--accent-fg`                             | text on the coral fill               |
| Focus              | `--focus`                                 | the ring, always visible             |
| Status             | `--ok/--fail/--pend/--run/--stop` + `-bg` | state text and tint                  |

Type scale (fixed, no fluid heads):
`--text-2xs 11` · `--text-xs 12` · `--text-sm 13` · `--text-base 14` ·
`--text-md 16` · `--text-lg 20` · `--text-xl 24` · `--text-2xl 28` · `--text-3xl 34`.

- Body 14px / 1.5. Prose max 65ch.
- Page title `--text-xl`, weight 600, `--tracking-head`.
- Section head `--text-md`, weight 600.
- Labels and meta: `--text-xs`, body face, sentence case, **never** uppercase,
  never letter-spaced, never mono.
- Mono (`--font-mono`) is for code, ids, env keys, hashes, model ids, file paths
  and numeric tables only. Never for a label, nav item or heading.

Spacing: `--space-1 2` `--space-2 4` `--space-3 6` `--space-4 8` `--space-5 12`
`--space-6 16` `--space-7 20` `--space-8 24` `--space-9 32` `--space-10 40`
`--space-11 48` `--space-12 64`. Use these, not raw pixels.

Controls: 32px high (`--control-h`), 26px small, radius `--radius-sm`.
One primary button style (coral fill, ink text) per screen; everything else is
the outlined or quiet variant. Every control has hover, focus-visible, active and
disabled states. Disabled = fill + ink + cursor, not opacity.

## Primitives

From `src/components/app.jsx`:

```jsx
<Page>
  {' '}
  // container, max 1400, 28px gutters
  <PageHeader title meta actions aside />
  <Toolbar end={<Pagination />}>...</Toolbar>
  <FigureStrip>
    <Figure label value note tone />
  </FigureStrip>
  <Panel title note actions>
    ...
  </Panel>
</Page>
```

From `src/components/ui.jsx`: `Button` (`primary | ghost | subtle | danger`),
`Spinner`, `ErrorState`, `EmptyState`, `StatusBadge`, `Toggle`, `SectionLabel`,
`KeyChip`.

CSS classes in `src/index.css` (use these, do not add page-local stylesheets):
`.table-wrap .data-table` (with `.cell-main`, `.cell-sub`, `.cell-num`,
`.cell-muted`, `.cell-actions`), `.filters .filter`, `.chip`, `.status`,
`.field`, `.input`, `.select`, `.textarea`, `.state-block`, `.dialog`,
`.section-head`, `.setting-row`.

## Composition rules per screen

1. One `Page` + one `PageHeader` per route. The header owns the route title and
   the one action; the topbar owns global search. Never repeat the same action
   in both places.
2. The main object of the screen leads: a table for lists, the run ledger for a
   scan, the definition rows for settings, the form for an editor. Never a grid
   of equal cards.
3. Tables before cards. Rows 48–56px, hairlines only, `th` in the body face at
   12px sentence case, figures right-aligned and tabular.
4. No card inside a card. A panel may contain rows; it may not contain another
   bordered panel.
5. Max two nesting levels of surface. Use `--surface-2` for the inner recess, no
   border.
6. Figures: label above, value at `--text-lg` weight 600, note below. No icon
   tiles, no trend arrows.
7. Every data region draws the four states it has logic for: loading (skeleton
   or spinner in place), empty (what belongs here + the one action), error (what
   broke + retry), full.
8. Dialogs use `.scrim` + `.dialog` (fixed, centred) and keep focus trapping
   (`useModalDialog`) and Escape handling.
9. Keep every link, form field, handler, route, `id`, `name`, `type`,
   `aria-label` and test hook that exists today. Do not rename props. Do not
   add features, metrics or copy that state a new fact.
10. Motion: `transform`/`opacity` only, `--dur-micro`/`--dur-short`, nothing
    loops except the Solid Glass status glyph while work is running.

## Copy rules

- Sentence case everywhere. No uppercase labels, no tracked caps.
- No em or en dashes. Use a comma, colon, full stop or parentheses.
- No middle-dot meta strings (`A · B · C`). Use columns, line breaks or separate
  spans with gaps.
- No arrow glued to link text. The label is the verb (`View all scans`).
- No decorative status dots. State is a word, optionally tinted.
- Numbers and machine values keep their existing formatting.

## Shell

`Layout` renders the fixed rail (236px, collapses to a drawer under 60rem) and
the 48px topbar. Sidebar groups: Operate, Configure, Workspace. Theme toggle and
engine status live in the rail foot. Search opens the command palette on ⌘K.
