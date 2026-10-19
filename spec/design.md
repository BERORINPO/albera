# Pigeonholes: design system (locked)

Status: locked for v1; v0.2 adds the canvas look (§3 canvas tokens, §12), approved by the owner. Source: the direction "Almanac", chosen from four design directions for clarity and feasibility, with details taken from the other three. The screen itself is specified in `spec/ui.md`; this file fixes the look, the motion and the voice. Change a value here first, then in `public/tokens.css`.

## 1. Genre and point of view

- **Genre: editorial ledger, custom theme "Columnar pad".** An accounting pad with a blue pencil in the margin. Rows are ruled, not boxed. Numbers sit in tabular columns. Headings read like the running heads of a book.
- **One accent, one meaning.** The blue pencil means "this one is yours, next". It appears on the next item (the lede and its row or slip), the lede's Open button, the wordmark's top-left cell and the favicon cell, and on needs-you marks on the canvas. Nothing else is coloured: not the context words, not the hand-off button, not the context tick (a full session is the user's choice, not "yours, next"). State is told by position, words and shape, never by hue.
- **Quiet is the reward.** When nothing needs you, the accent leaves the page completely (lede, rows, wordmark, favicon). No praise, no illustration, no confetti.
- **Delight comes from speed and proof, not decoration**: one key to the next item, Open in one press, a verified "9 of 14 archived" while Claude works.
- **The board is a reference, not a control panel.** It never changes anything, so it must not look like a dashboard: no tiles, no KPI blocks, no chips.

## 2. Hallmark stamp (every CSS file starts with this block)

Every file in `public/*.css` begins with exactly this comment block (byte for byte, starting at the first byte of the file), then a blank line:

```css
/* Hallmark · genre: editorial · theme: custom "Columnar pad" (tuned) · app screen, no macrostructure
 * vibe: accounting pad, blue pencil in the margin, quiet when done
 * paper oklch(97.3% 0.009 190) · accent oklch(47% 0.150 264) blue pencil · display: book serif + mincho · body: DIN + UD gothic
 * axes: light paper / roman-serif display / cool accent · one accent family, no state hues
 * pre-emit critique: P4 H4 E4 S4 R4 V4
 */
```

A file may add one line after the stamp saying what it holds (`/* rows.css: piles, rows, detail, family tree */`).

## 3. Tokens (`public/tokens.css`, byte for byte below the stamp)

Tokens are emitted twice for dark mode: once under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and once under `:root[data-theme="dark"]`. Never `light-dark()` (it fails as a whole on older engines). There is no theme toggle in the UI; `data-theme` exists for screenshots and tests (`?theme=light|dark` sets it, not persisted).

```css
/* ---------- Light (default) ---------- */
:root {
  color-scheme: light;

  /* Neutrals lean toward the anchor hue 190 (the pale green-grey of a columnar pad). */
  --color-paper:       oklch(97.3% 0.009 190);  /* page and body background */
  --color-paper-2:     oklch(94.6% 0.012 190);  /* cursor row, picked row, hover */
  --color-paper-3:     oklch(91.6% 0.015 190);  /* pressed, arrival fade */
  --color-rule:        oklch(86.0% 0.020 188);  /* hairlines between rows (decoration only) */
  --color-rule-strong: oklch(56.0% 0.020 205);  /* borders of inputs, outline buttons, checkboxes */
  --color-muted:       oklch(47.5% 0.020 215);  /* notes, meta, zero counts */
  --color-ink-2:       oklch(35.0% 0.022 230);  /* second text, times, verbs */
  --color-ink:         oklch(21.5% 0.024 245);  /* blue-black ink: titles, body */

  /* One accent family: the blue pencil. Means "this one is yours, next". */
  --color-accent:      oklch(47.0% 0.150 264);  /* accent text and marks */
  --color-accent-fill: oklch(47.0% 0.150 264);  /* the one filled button */
  --color-on-accent:   oklch(98.5% 0.006 264);  /* text on the filled button */
  --color-focus:       oklch(47.0% 0.150 264);  /* 2px focus ring */

  --color-scrim:       oklch(21.5% 0.024 245 / 0.36); /* <dialog>::backdrop only */

  /* Canvas (v0.2): each one is a palette step above (the dark desk: one step below paper), no new hue. Change it together with its source. */
  --cv-desk:           oklch(91.6% 0.015 190);  /* = paper-3: the desk between project sheets, a pinned head */
  --cv-sheet:          oklch(97.3% 0.009 190);  /* = paper: a project sheet (one step lighter than the desk) */
  --cv-cursor:         oklch(94.6% 0.012 190);  /* = paper-2: the cursor slip on a sheet */

  /* Type: OS faces only. Latin first, then the Japanese face of the same voice.
   * Swap a vendored OFL face in by editing these three lines. */
  --font-display: "Sitka Heading", "Sitka Text", "Iowan Old Style", "Charter", "Noto Serif",
                  "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Noto Serif CJK JP", "Noto Serif JP", serif;
  --font-body:    "Bahnschrift", "Avenir Next", "Noto Sans",
                  "BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI",
                  "Noto Sans CJK JP", "Noto Sans JP", sans-serif;
  --font-mono:    "Cascadia Mono", "Consolas", "SF Mono", "Menlo", "DejaVu Sans Mono",
                  "BIZ UDGothic", "Noto Sans Mono CJK JP", ui-monospace, monospace;

  /* Scale: ratio 1.25, five sizes, nothing below 13px. */
  --text-sm:   0.8125rem;  /* 13px  meta, times, verbs, kbd, footer */
  --text-base: 1rem;       /* 16px  row titles, body, buttons */
  --text-md:   1.25rem;    /* 20px  pile heads, wordmark, quoted question in the lede */
  --text-lg:   1.5625rem;  /* 25px  lede cap when the title is long */
  --text-xl:   1.953rem;   /* 31px  lede at 1280 */
  --text-lede: clamp(var(--text-md), 0.95rem + 1.25vw, var(--text-xl));

  --leading-display: 1.3;
  --leading-body: 1.6;

  /* Space: 4pt, named by size. */
  --space-3xs: 0.125rem;  /*  2px */
  --space-2xs: 0.25rem;   /*  4px */
  --space-xs:  0.5rem;    /*  8px */
  --space-sm:  0.75rem;   /* 12px */
  --space-md:  1rem;      /* 16px */
  --space-lg:  1.5rem;    /* 24px */
  --space-xl:  2.5rem;    /* 40px */
  --space-2xl: 4rem;      /* 64px */
  --gutter: clamp(1rem, 3vw, 2.5rem);  /* page side margin: 16px at 400, 40px at 1280 */
  --mark: 0.875rem;                    /* the margin column for the pencil mark and cursor */
  --measure: 46rem;

  /* Lines and corners. Rows have no corners: they are ruled, not boxed. */
  --rule-hair:  1px solid var(--color-rule);
  --rule-ink:   1px solid var(--color-ink);
  --rule-total: 3px double var(--color-ink);   /* ledger total line: masthead, index total, selection bar */
  --radius-control: 3px;
  --radius-dialog:  6px;
  --hit: 2.75rem;  /* 44px minimum target, reached with padding or a ::before overlay */

  /* Motion: three easings, three durations, three primitives (see design.md). */
  --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in:     cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-short:  190ms;   /* chevron turn, leave */
  --dur-long:   360ms;   /* disclose */
  --dur-arrive: 1200ms;  /* one-shot arrival fade */

  --z-sticky: 200;  /* pile heads */
  --z-bar:    210;  /* selection bar */
  --z-modal:  400;  /* <dialog> */
}

/* ---------- Dark: follows the OS unless the toggle says light ---------- */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --color-paper:       oklch(24.0% 0.017 200);  /* dark petrol slate, not GitHub blue-black */
    --color-paper-2:     oklch(29.0% 0.019 200);  /* steps of 4-5 L points: 3.5 vanished in the dark */
    --color-paper-3:     oklch(33.0% 0.021 200);
    --color-rule:        oklch(43.0% 0.019 200);  /* 2.0:1 on paper: seen, still quieter than any edge */
    --color-rule-strong: oklch(64.0% 0.020 205);
    --color-muted:       oklch(75.5% 0.018 205);
    --color-ink-2:       oklch(86.0% 0.013 205);
    --color-ink:         oklch(95.0% 0.008 200);
    --color-accent:      oklch(80.0% 0.095 262);
    --color-accent-fill: oklch(78.0% 0.100 262);
    --color-on-accent:   oklch(22.0% 0.030 262);
    --color-focus:       oklch(80.0% 0.095 262);
    --color-scrim:       oklch(12.0% 0.012 200 / 0.62);
    --cv-desk:           oklch(19.5% 0.015 200);  /* one step below paper: the desk sits under the pages, as in light */
    --cv-sheet:          oklch(29.0% 0.019 200);  /* = paper-2 */
    --cv-cursor:         oklch(37.0% 0.021 200);  /* 1.36:1 on the sheet (paper-3 was 1.16, too close on a dark screen) */
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --color-paper:       oklch(24.0% 0.017 200);
  --color-paper-2:     oklch(29.0% 0.019 200);
  --color-paper-3:     oklch(33.0% 0.021 200);
  --color-rule:        oklch(43.0% 0.019 200);
  --color-rule-strong: oklch(64.0% 0.020 205);
  --color-muted:       oklch(75.5% 0.018 205);
  --color-ink-2:       oklch(86.0% 0.013 205);
  --color-ink:         oklch(95.0% 0.008 200);
  --color-accent:      oklch(80.0% 0.095 262);
  --color-accent-fill: oklch(78.0% 0.100 262);
  --color-on-accent:   oklch(22.0% 0.030 262);
  --color-focus:       oklch(80.0% 0.095 262);
  --color-scrim:       oklch(12.0% 0.012 200 / 0.62);
  --cv-desk:           oklch(19.5% 0.015 200);
  --cv-sheet:          oklch(29.0% 0.019 200);
  --cv-cursor:         oklch(37.0% 0.021 200);
}

html { background: var(--color-paper); }
body { background: var(--color-paper); color: var(--color-ink); }
```

Runtime custom properties (set by JS through CSSOM, `element.style.setProperty`, never a `style` attribute): `--bar-h` (selection bar height, for `scroll-padding-bottom`) and `--head-h` (sticky pile head height, for `scroll-padding-top`), both from one `ResizeObserver`; on the canvas (ui.md §10) `--tx`, `--ty`, `--z` (the camera, on the world element), `--k` (`1 / min(z, 1)`, the counter-scale for text and rules), `--x`, `--y`, `--w`, `--h` (world units, on each sheet and slip) and `--p` (0–100, on each context tick).

### 3.1 Contrast (computed from the tokens; a token change must keep these)

| pair | light | dark | need |
|---|---|---|---|
| ink / paper | 16.23 | 14.18 | 4.5 |
| ink-2 / paper-3 (worst ink-2) | 8.81 | 7.95 | 4.5 |
| muted / paper-3 (worst muted) | 5.20 | 5.58 | 4.5 |
| accent / paper-2 | 6.02 | 7.48 | 4.5 |
| on-accent / accent-fill | 6.72 | 8.62 | 4.5 |
| rule-strong / paper-2 (UI borders) | 3.96 | 4.20 | 3 |
| rule-strong / paper-3 (worst UI border) | 3.62 | 3.63 | 3 |
| focus / paper-2 | 6.02 | 7.48 | 3 |

`--color-rule` is decoration only (on paper 1.41 / 2.04, on paper-2 1.30 / 1.74): never the only edge of a control. Every row and slip is also told by its title, its spacing and the ink rules, so the board reads with the hairlines removed.

Dark steps (v0.2 readability pass, owner feedback "hard to read" in the dark side pane): the surfaces sit 4 to 5 L points apart (paper 24, paper-2 29, paper-3 33; the canvas desk 19.5 below them) and the hairline at 43. At the earlier 3.5-point steps the cursor band, the sheets and the hairlines all but vanished on a dark screen. Hairlines stay under 3:1 on purpose: a 3:1 hairline needs about L 56 and would rule every row as loudly as a control border.

Canvas pairs (v0.2; the worst surface for each ink, computed the same way):

| pair | light | dark | need |
|---|---|---|---|
| ink / cv-desk (running head, pinned head) | 13.71 | 15.79 | 4.5 |
| ink / cv-sheet | 16.23 | 12.14 | 4.5 |
| ink-2, worst canvas surface (light: cv-desk, the head counts; dark: cv-cursor) | 8.81 | 6.78 | 4.5 |
| muted, worst canvas surface (light: cv-desk, the "No project folder" name; dark: cv-cursor) | 5.20 | 4.76 | 4.5 |
| accent, worst canvas surface (light: cv-desk, a head's Needs-you count; dark: cv-cursor, the next slip under the cursor) | 5.50 | 5.51 | 4.5 |
| focus / cv-cursor | 6.02 | 5.51 | 3 |
| rule-strong / cv-cursor (the tick's ruler ends, the band line's rule) | 3.96 | 3.10 | 3 |
| cv-cursor / cv-sheet (the cursor band; decoration: the ink bar carries the state) | 1.08 | 1.36 | — |

`--cv-sheet` against `--cv-desk` is 1.18 / 1.30 (v0.2 first cut: 1.08 / 1.11, the sheets floated as loose rules on a dark desk): decoration only. A sheet's edge is always told by its ink top rule and its double total rule, never by the fill alone, so the canvas still reads with the fill removed (forced colours, print).

Resolved light values (for the favicon, which cannot read CSS variables): paper `#f0f8f7`, ink `#101b24`, accent `#2e54ae`.

## 4. Type

| role | token | weights | used for |
|---|---|---|---|
| display | `--font-display` | 600 only | wordmark, lede title, the quoted question in the lede and in needs-you rows, pile heads, canvas running heads, legend names |
| body | `--font-body` | 400, 700 (the same in dark mode) | everything else, including all numbers and the context words |
| code | `--font-mono` | 400 | `kbd`, session IDs, folder paths, the copied instructions, branch names, and the targets in the doing words (file names, command heads, hosts, connector names) |

- Three roles only (Hallmark "2+1"). Each role mixes a Latin face and the Japanese face of the same voice, Latin first. No downloaded fonts; a vendored OFL face may replace a stack line later, nothing else changes.
- `font-synthesis: none` (no fake bold or italic). No italics for emphasis anywhere; emphasis is weight.
- No lighter body in dark mode. The Japanese faces have no 350, so a 350 body drew one line in two stroke weights (the Latin thin, the Japanese at 400) and made 13px muted meta look fainter than its ratio.
- Numbers: `font-variant-numeric: tabular-nums lining-nums` on times, counts, tallies, the ledger and `<time>`.
- Leading: body 1.6, display 1.3. Under `[lang="en"]`: body 1.5, display 1.22.
- Japanese line breaking: `:lang(ja) { word-break: auto-phrase; line-break: strict; }`. Fixed frame words around a title (「まず」「に答える」) never break inside.
- Quotes follow the language of the quoted content: `q:lang(ja) { quotes: "「" "」" "『" "』"; }`, `q:lang(en) { quotes: "\201C" "\201D" "\2018" "\2019"; }`. A `<q>` gets the `lang` of its content (see `contentLang` in ui.md §15).
- Titles wrap to 2 lines and clamp; they never truncate to one line with an ellipsis (the `title` attribute does not reach touch or screen-reader users). Two places quote a title inside other words, and there the title gives way, never the words around it: the lede sentence is fitted to its lines by shortening only the quoted title, with `…` right before the closing quote (the `h1`'s name keeps the whole sentence); a family link names its parent in one line, the parent's title cut first (the parent's own row shows it whole). Project names in one-line places (the far running head, the Only-to-archive lines) are cut with `…`.

## 5. Scale

`--text-sm` 13px, `--text-base` 16px, `--text-md` 20px, `--text-lg` 25px, `--text-xl` 31px; lede `--text-lede` (20 to 31px fluid), capped at `--text-lg` when the title is longer than 40 characters (`.lede--long`). Nothing is smaller than 13px. Buttons are 16px; text buttons and meta are 13px.

## 6. Space, lines, corners, layers

- Spacing is the 4pt scale above. Between piles: `--space-xl`. Row padding: `--space-sm` block (action piles), `--space-xs` (Working, Recent). Density tells urgency.
- Page: max width 80rem, side gutter `--gutter` (16px at 400, 40px at 1280).
- Lines: rows are separated by `--rule-hair`; pile heads sit on `--rule-ink`; the masthead, the ledger total and the selection bar use `--rule-total` (the accounting total line).
- Corners: `--radius-control` (3px) on buttons, inputs, kbd; `--radius-dialog` (6px) on dialogs. Rows, piles, banners, the selection bar, canvas sheets, slips and the canvas bar have no corners and no shadows.
- Layers: pile heads `--z-sticky`, selection bar `--z-bar`, dialogs `--z-modal`. Nothing else is positioned above the flow. The masthead is not sticky. The canvas viewport is its own stacking context (it clips): inside it, sheets and slips are in the flow of the world element and a pinned running head uses `--z-sticky`; the canvas bar is a grid row, not positioned.
- Hit targets: every control is at least 44×44 through padding or a transparent `::before` overlay (`--hit`). The only exception is a slip at the canvas far level (its world cell × the zoom can be under 44px), which has an equivalent control (its row in the list, one `v` away), as WCAG 2.5.8 allows.

## 7. Motion (three primitives, nothing loops)

| # | primitive | where | how | reduced motion |
|---|---|---|---|---|
| 1 | **disclose** | row detail, Recent and To archive bodies, sub-groups | `grid-template-rows: 0fr → 1fr` over `--dur-long` with `--ease-in-out`; the chevron turns over `--dur-short` with `--ease-out` | instant (0 ms) |
| 2 | **leave** | only a row whose ID was copied and is now verified archived | the row fades (`opacity` 1 → 0, `--dur-short`, `--ease-in`), then its slot collapses (`grid-template-rows: 1fr → 0fr`, `--dur-short`, delay `--dur-short`); a 450 ms timeout removes the node even if `transitionend` never fires | 150 ms linear opacity only, then removed |
| 3 | **arrive** | a row or canvas slip newly in Needs you, Stuck? or Unread (never on first paint) | a `--color-paper-3` overlay on the row or slip fades 1 → 0 over `--dur-arrive` (1.2 s), once | no overlay at all (`display: none`); the row's "New" word still shows |

- Not counted as motion (state feedback): the 1px press (`translateY(1px)` on `:active`), hover colour changes (`--dur-short`), the chevron.
- The canvas adds no primitive. Camera moves (pan, zoom, jumps to a slip, fit all) are instant, never animated; a slip that changes slot and a sheet that is pushed down move instantly. A camera glide would be a fourth primitive and is not in v0.2.
- Never: infinite animation, pulsing dots, spinners before 300 ms, skeleton shimmer, count-up numbers, smooth-scroll under reduced motion, anything that moves every second. Times change at minute granularity only.
- Under `prefers-reduced-motion: reduce`: `transition-duration: 0ms` and `animation: none` everywhere, except the leave fade above; `scrollIntoView` uses `behavior: 'auto'`.

## 8. Microinteraction stance

- **Press**: every button and link moves down 1px on `:active`. The filled and ink buttons darken on hover (`@media (hover: hover)` only); outline and text buttons get `--color-paper-2`.
- **Focus**: one ring for everything: `outline: 2px solid var(--color-focus); outline-offset: 2px;` on `:focus-visible`, shown instantly, never animated, never removed.
- **Hover** never reveals a control. Everything a mouse can reach on hover is visible without it (Open links, chevrons on touch). Hover only underlines or tints.
- **Copy feedback is a label swap**, not a toast: "Copy ID" becomes "Copied ✓" for 2.5 s (so do the hand-off guide's Copy and open and Copy only). Long-lived guidance (paste, progress) lives in the selection bar, the hand-off guide and the canvas bar, which stay until you close them.
- **Disabled**: `--color-paper-3` fill, `--color-muted` text, `cursor: not-allowed`, `aria-disabled="true"` (kept in the tab order when it explains itself, e.g. Open for a session ID the app cannot open).
- **Busy**: the button keeps its label and gets `aria-busy="true"`; no spinner.
- **Checkboxes** are native, `accent-color: var(--color-ink)`, with a 44px hit area; group checkboxes are tri-state (`indeterminate`).

### 8.1 Control kinds

| kind | class | look | at most |
|---|---|---|---|
| filled | `.btn.btn--fill` | accent fill, on-accent text, 700 | one on the page: the lede's Open |
| ink | `.btn.btn--ink` | ink fill, paper text, 700 | the main action of a bar or guide: the selection bar's Copy instruction, the hand-off guide's Copy and open (or Copy for a new session) |
| outline | `.btn.btn--line` | transparent, rule-strong border | secondary actions (Copy again, Reload, Clear filter, Review them, Copy only) |
| text | `.textbtn` | 13px ink-2, underlined in rule-strong | language, ?, Clear selection, Copy ID, Show only these, Canvas / List, Hand off, Time to hand off N, zoom −/+, Fit all, Rearrange, Close |
| link | `a.row__open` | 13px ink-2, "Open ↗" | one per row or slip |

The row's Hand off text button is ink and 700 (`.textbtn.is-strong`): it is the one action a full session asks for, and it is still not the accent. A `kbd` appears inside a control only on the lede's Open (`Enter`), the selection bar's Copy instruction (`c`), the filter field (`/`), the view switch (`v`), the canvas Fit all (`f`) and the no-match Clear filter (`Esc`). It is a visual hint only (`aria-hidden`; the key goes in `aria-keyshortcuts`), and the single-character ones hide while single-key shortcuts are off. The footer and the `?` dialog carry the other keys.

## 9. Voice (copy rules for both languages)

1. **One name per pile, everywhere** (ledger, pile head, tab title, notifications, help, canvas running heads and legend): 返事待ち / 止まったかも / 未読 / 作業中 / 最近 / 片付け; Needs you / Stuck? / Unread / Working / Recent / To archive.
2. **Labels are nouns or plain verbs. Buttons are 1 to 3 words, verb first** (Open, Copy instruction, Clear selection). Past tense only in notices ("9 of 14 archived").
3. **One sentence says what happened and what to do next.** Numbers first and exact.
4. **Every time carries its state word**: 「2 時間待ち」 "waiting 2 h", 「40 分前に停止」 "stopped 40 min ago", 「3 時間動きなし」 "quiet 3 h", 「12 分前に終了」 "done 12 min ago". Minutes, hours, days; never ticking seconds (seconds appear only in the stale notice).
5. **Content is quoted, never translated**: titles, questions, summaries, error text and folder names pass through. Inline content sits in quotes written in the template (『』 in Japanese, “ ” in English); a whole question body is a `<q>` element. Claude's own short words in the doing line (its description of a command, the plan step in progress) are content too: quoted or prefixed (`doing.note`, `doing.step`), never translated. Targets (file names, command heads, hosts, connector names) are shown as `code`.
6. **No separator chains.** Meta items are separated by space (CSS `column-gap`), lists by 「、」 / ", ", sentences by 「。」 / ". ". One `·` is never used as a joiner.
7. **No metaphor in functional copy**: no "edition", "desk", "sheet", "slip", "tray", "shelf" in errors, loading or buttons ("desk", "sheet" and "slip" are names in this spec only; the screen says Canvas, project and session). (The product name is the only metaphor.)
8. **Never**: "!", emoji, praise (お疲れさま, Great job), apologies (申し訳ありません, Oops), "AI", "smart", 「〜しましょう」, internal words (盤面, epitaxy, formatSuspect, contextSuspect, reason codes, activity kinds, level codes, token field names), personal paths, model names, shell-specific syntax in the UI. The only commands shown are the ways to start the board: `npx pigeonholes`, and `npm start` in a clone. The canvas placement is a fixed rule: never call it "AI" or "smart"; its button is "Rearrange".
9. English is 1.5 to 3 times longer than Japanese. Buttons never wrap to two lines; their parent row wraps instead.
10. "Claude" appears only descriptively ("paste it into Claude", "the Claude app"). The disclaimer says the tool is unofficial.

## 10. Identity

- **Name**: Pigeonholes (npm package and bin `pigeonholes`). Never "Claude" in the name, logo or page title.
- **Wordmark**: a 2×3 cabinet glyph (six 6×3.5 cells in a 16-unit box, 1px ink strokes) followed by "Pigeonholes" in `--font-display` 600 at `--text-md`. The top-left cell fills with `--color-accent` while anything needs you. The same glyph, the same layout, is the favicon (ui.md §13) and its cell order matches the ledger and keys 1 to 6 (left column: Needs you, Stuck?, Unread; right column: Working, Recent, To archive).
- **No other logo**, no sparkle, no Claude orange, no warm cream paper.

## 11. The never list

- Cards, boxed rows, card-in-card, drop shadows, glows, gradients, glass, dotted-grid backgrounds. (A canvas sheet is a flat ruled page with no corner and no shadow, §12; a slip is a ruled entry on it, never a box.)
- Side stripes or coloured left borders on rows.
- Pills, chips, badges, tags on rows; per-row state icons that repeat the pile name (the only row mark is the next-item square and the cursor triangle; on the canvas the pile shape of §12 stands in for the pile head the slip has no room for).
- Traffic-light palettes or any second state hue. The accent is the only colour.
- KPI tiles, big-number stat grids, bar-like strips, barcode-like mark fields, fill bars, rings or arcs for the context size. (The canvas context tick, §12, is a glyph: one 2px mark on a short ruler next to the number, never a filled length.)
- A minimap, a squared or dotted desk, lines between sheets, a camera that moves on a poll, a sheet that moves sideways or up on its own.
- A sticky element taller than the viewport; a sticky side column; a floating rounded action bar.
- Hover-only controls; `display: none` on a control to hide it from some users; Open as a row's main click target.
- `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `style` attributes, inline scripts.
- `light-dark()`-only tokens; CSS multi-column for live lists.
- Intl output in the UI or in tests (only `Intl.PluralRules` to pick a form).
- Downloaded fonts, external requests of any kind.
- Text below 13px; synthetic bold; italic emphasis; all-caps eyebrow labels.
- A lede that repeats the ledger; the same session three times on the first screen.
- Ticking clocks, looping or pulsing motion, sounds.
- Esc or any single key that clears a selection.
- Real session data or personal paths in any shipped file, demo or screenshot.

## 12. The canvas look (v0.2, owner-approved)

The canvas is a second view of the same board (behaviour: ui.md §10). It is drawn from the same pad: ruled pages on a plain desk. Every value below uses the tokens of §3; nothing new is coloured.

- **Desk**: the viewport is filled with `--cv-desk` and nothing else (no grid, no dots, no minimap). In both themes it is one step darker than the page (light paper-3; dark 19.5, below paper), so the sheets lie on it as paper on a desk.
- **Sheet** (one per project with anything not To archive): a flat page of the columnar pad, `--cv-sheet` fill, no corner, no shadow. Top edge `--rule-ink` (`1px solid var(--color-ink-2)` on a quiet sheet: only Recent and To archive in it). `--rule-hair` between columns over the full height of the live area. `1px solid var(--color-rule-strong)` above the band line. Foot `--rule-total`. These rules, not the fill, make the edge (§3.1).
- **Running head**, above its sheet: the project name in the display face 600 (`--text-md` at mid and near, `--text-base` at far; the "No project folder" sheet's name in `--color-muted`), then the counts of the four slip piles in the body face at `--text-sm` (Needs you, Stuck? and Unread bold ink when above 0, Working ink-2, zero piles left out; Recent and To archive are on the band line). From the moment the viewport top would cut the head, it is pinned whole to the viewport top (`--z-sticky`): `--cv-desk` behind it and the sheet's own top rule under it (`--rule-ink`; ink-2 on a quiet sheet), the sheet's width plus one rule width each side, so it reads as the sheet's top edge held in place and slips scroll under a clean rule. When less than 20px of the sheet would show under it, the whole sheet is hidden at once: a head never rides out half cut and no sliver of the double rule shows at the viewport top. It pins sideways too: when the sheet's left edge is off the viewport, the name slides inside it (only `--x` / `--y` on the head box move). At far the head is one line, the name first and the count of your turn after it only when it fits (bold ink; none at 0; otherwise it wraps to a clipped second line, so a name is never cut for a count), about 23px tall: it fits the gap above its sheet down to about 20 % (it may run 56 of the 96 gap units into the gap on its right, never into the next head; on the narrow canvas, one column with nothing to its right, up to twice the sheet's width), and its box is clipped to the gap below that, so it never covers the sheet above. The head box sits 2 rule widths above the sheet's top rule (`bottom: calc(100% + 2px * var(--k))`), so its desk fill never shares a device pixel row with the rule (the rule reads the same under the name and after it). Its height is measured unpinned (the pinned padding and rule would make a head jump 5px on the next render).
- **Slip** (one per session in Needs you, Stuck?, Unread or Working; one width, each row as tall as its tallest slip): a ruled entry, never a box: `--rule-hair` on top (the sheet's ink rule on the first row) and the column hairlines at its sides; padding 12 world units (it shrinks with the zoom on purpose). Cursor slip: `--cv-cursor` band **and** a 3px `--color-ink` bar on its inline-start edge (the band alone is 1.08 / 1.36:1 on the sheet, so the bar carries the state, WCAG 1.4.11; under forced colours a 2px `Highlight` outline and a `Highlight` bar, so it differs from the forced 1px cell rules). Next slip: accent time and accent Open, like `.is-next`. Recent and To archive sessions are not slips: no one-line rows, no faded entries (they were the noisiest part of the first cut: rows of titles cut to one line, bright and muted lines alternating).
- **Pile marks** (a 10px glyph at the start of the slip; the only state sign, read in greyscale by shape):

| pile | mark |
|---|---|
| Needs you | filled square, `--color-accent` |
| Stuck? | filled triangle, `--color-ink` |
| Unread | filled circle, `--color-ink` |
| Working | ring (1.5px border), `--color-ink-2` |
| Recent, To archive | no mark: they are words on the band line |

  Under forced colours the marks, the cursor band edge and the next square keep their shapes in system colours (`Highlight` for Needs you, `CanvasText` for the others) with `forced-color-adjust: none`.
- **Band line** (Recent and To archive, at the sheet's foot): one line, `1px solid var(--color-rule-strong)` above it (none on a sheet with no slips, where it sits right under the top rule), two text buttons in 13px ink-2: the pile name and the session count, the same count as the running head's label. Shown at near and mid; at far the line and its rule are empty. No titles, marks or strokes: the band is words, so it never reads as a row of marks.
- **Context tick** (canvas only; the list and every accessible name use words): a short ruler 28×7px with 1px `--color-rule-strong` sides and bottom (no top), a 2×11px `--color-ink-2` tick at `left: calc(var(--p) * 1%)`, then the number in tabular figures. At the due and soon levels the tick is ink and 14px tall and the number is ink 700. No fill, no arc, no colour, never the accent. A guessed window reads 「約 82%」 / "~82%". The tick is `aria-hidden`.
- **Families**: no lines between slips (drawn on the rules, a connector read as fragments) and no grouping (slips go by urgency, as in the list). Every child says `↳ Parent: …` on its near "where" line.
- **Counter-scale**: inside the world every font size, border width and node radius is multiplied by `--k = 1 / min(z, 1)`, so text and rules keep their screen size when zoomed out (nothing below 13px at any zoom) and grow above 100 %. Cells and paddings stay in world units: the zoom level decides what fits (ui.md §10.5).
- **Front strip and bar**: in the canvas view the front is one row (the lede title at `--text-md` with a 2-line clamp, the ledger as one line of `name n` links), and the canvas bar is the view's foot: full width, `--rule-total` above, opaque `--color-paper`, no corner, no shadow, never floating.
- **Filtering dims, it never removes**: a slip that does not match has its title and text in `--color-muted`, and its mark keeps its pile's shape in `--color-muted` (filled square, triangle and circle, the Working ring). Dimming changes colour only, never shape: a hollow ring would read as the Working mark. Under forced colours the dimmed marks are `GrayText`. No `opacity` on text.
