# Pigeonholes: design system (locked)

Status: locked for v1. Source: the direction "Almanac", chosen from four design directions for clarity and feasibility, with details taken from the other three. The screen itself is specified in `spec/ui.md`; this file fixes the look, the motion and the voice. Change a value here first, then in `public/tokens.css`.

## 1. Genre and point of view

- **Genre: editorial ledger, custom theme "Columnar pad".** An accounting pad with a blue pencil in the margin. Rows are ruled, not boxed. Numbers sit in tabular columns. Headings read like the running heads of a book.
- **One accent, one meaning.** The blue pencil means "this one is yours, next". It appears on the next item (the lede and its row), the lede's Open button, the wordmark's top-left cell and the favicon cell, and on needs-you marks in the Overview. Nothing else is coloured. State is told by position, words and shape, never by hue.
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
    --color-paper-2:     oklch(27.5% 0.019 200);
    --color-paper-3:     oklch(31.0% 0.021 200);
    --color-rule:        oklch(36.0% 0.019 200);
    --color-rule-strong: oklch(62.0% 0.020 205);
    --color-muted:       oklch(74.0% 0.018 205);
    --color-ink-2:       oklch(85.0% 0.013 205);
    --color-ink:         oklch(95.0% 0.008 200);
    --color-accent:      oklch(80.0% 0.095 262);
    --color-accent-fill: oklch(78.0% 0.100 262);
    --color-on-accent:   oklch(22.0% 0.030 262);
    --color-focus:       oklch(80.0% 0.095 262);
    --color-scrim:       oklch(12.0% 0.012 200 / 0.62);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --color-paper:       oklch(24.0% 0.017 200);
  --color-paper-2:     oklch(27.5% 0.019 200);
  --color-paper-3:     oklch(31.0% 0.021 200);
  --color-rule:        oklch(36.0% 0.019 200);
  --color-rule-strong: oklch(62.0% 0.020 205);
  --color-muted:       oklch(74.0% 0.018 205);
  --color-ink-2:       oklch(85.0% 0.013 205);
  --color-ink:         oklch(95.0% 0.008 200);
  --color-accent:      oklch(80.0% 0.095 262);
  --color-accent-fill: oklch(78.0% 0.100 262);
  --color-on-accent:   oklch(22.0% 0.030 262);
  --color-focus:       oklch(80.0% 0.095 262);
  --color-scrim:       oklch(12.0% 0.012 200 / 0.62);
}

html { background: var(--color-paper); }
body { background: var(--color-paper); color: var(--color-ink); }
```

Runtime custom properties (set by JS through CSSOM, `documentElement.style.setProperty`, never a `style` attribute): `--bar-h` (selection bar height, for `scroll-padding-bottom`) and `--head-h` (sticky pile head height, for `scroll-padding-top`). Both come from one `ResizeObserver`.

### 3.1 Contrast (computed from the tokens; a token change must keep these)

| pair | light | dark | need |
|---|---|---|---|
| ink / paper | 16.23 | 14.18 | 4.5 |
| ink-2 / paper-3 (worst ink-2) | 8.81 | 8.29 | 4.5 |
| muted / paper-3 (worst muted) | 5.20 | 5.70 | 4.5 |
| accent / paper-2 | 6.02 | 7.86 | 4.5 |
| on-accent / accent-fill | 6.72 | 8.62 | 4.5 |
| rule-strong / paper-2 (UI borders) | 3.96 | 4.08 | 3 |
| focus / paper-2 | 6.02 | 7.86 | 3 |

`--color-rule` is decoration only (1.41 / 1.52): never the only edge of a control.

Resolved light values (for the favicon, which cannot read CSS variables): paper `#f0f8f7`, ink `#101b24`, accent `#2e54ae`.

## 4. Type

| role | token | weights | used for |
|---|---|---|---|
| display | `--font-display` | 600 only | wordmark, lede title, the quoted question in the lede and in needs-you rows, pile heads, legend names |
| body | `--font-body` | 400, 700 (dark mode body 350) | everything else, including all numbers |
| code | `--font-mono` | 400 | `kbd`, session IDs, folder paths, the copied instruction |

- Three roles only (Hallmark "2+1"). Each role mixes a Latin face and the Japanese face of the same voice, Latin first. No downloaded fonts; a vendored OFL face may replace a stack line later, nothing else changes.
- `font-synthesis: none` (no fake bold or italic). No italics for emphasis anywhere; emphasis is weight.
- Numbers: `font-variant-numeric: tabular-nums lining-nums` on times, counts, tallies, the ledger and `<time>`.
- Leading: body 1.6, display 1.3. Under `[lang="en"]`: body 1.5, display 1.22.
- Japanese line breaking: `:lang(ja) { word-break: auto-phrase; line-break: strict; }`. Fixed frame words around a title (「まず」「に答える」) never break inside.
- Quotes follow the language of the quoted content: `q:lang(ja) { quotes: "「" "」" "『" "』"; }`, `q:lang(en) { quotes: "\201C" "\201D" "\2018" "\2019"; }`. A `<q>` gets the `lang` of its content (see `contentLang` in ui.md §15).
- Titles wrap to 2 lines and clamp; they never truncate to one line with an ellipsis (the `title` attribute does not reach touch or screen-reader users).

## 5. Scale

`--text-sm` 13px, `--text-base` 16px, `--text-md` 20px, `--text-lg` 25px, `--text-xl` 31px; lede `--text-lede` (20 to 31px fluid), capped at `--text-lg` when the title is longer than 40 characters (`.lede--long`). Nothing is smaller than 13px. Buttons are 16px; text buttons and meta are 13px.

## 6. Space, lines, corners, layers

- Spacing is the 4pt scale above. Between piles: `--space-xl`. Row padding: `--space-sm` block (action piles), `--space-xs` (Working, Recent). Density tells urgency.
- Page: max width 80rem, side gutter `--gutter` (16px at 400, 40px at 1280).
- Lines: rows are separated by `--rule-hair`; pile heads sit on `--rule-ink`; the masthead, the ledger total and the selection bar use `--rule-total` (the accounting total line).
- Corners: `--radius-control` (3px) on buttons, inputs, kbd; `--radius-dialog` (6px) on dialogs. Rows, piles, banners and the selection bar have no corners and no shadows.
- Layers: pile heads `--z-sticky`, selection bar `--z-bar`, dialogs `--z-modal`. Nothing else is positioned above the flow. The masthead is not sticky.
- Hit targets: every control is at least 44×44 through padding or a transparent `::before` overlay (`--hit`). The only exception is an Overview mark (14px), which has an equivalent control (its row), as WCAG 2.5.8 allows.

## 7. Motion (three primitives, nothing loops)

| # | primitive | where | how | reduced motion |
|---|---|---|---|---|
| 1 | **disclose** | row detail, Recent and To archive bodies, sub-groups, the Overview, the folded quiet shelves | `grid-template-rows: 0fr → 1fr` over `--dur-long` with `--ease-in-out`; the chevron turns over `--dur-short` with `--ease-out` | instant (0 ms) |
| 2 | **leave** | only a row whose ID was copied and is now verified archived | the row fades (`opacity` 1 → 0, `--dur-short`, `--ease-in`), then its slot collapses (`grid-template-rows: 1fr → 0fr`, `--dur-short`, delay `--dur-short`); a 450 ms timeout removes the node even if `transitionend` never fires | 150 ms linear opacity only, then removed |
| 3 | **arrive** | a row newly in Needs you, Stuck? or Unread (never on first paint) | a `--color-paper-3` overlay on the row fades 1 → 0 over `--dur-arrive` (1.2 s), once | no overlay at all (`display: none`); the row's "New" word still shows |

- Not counted as motion (state feedback): the 1px press (`translateY(1px)` on `:active`), hover colour changes (`--dur-short`), the chevron.
- Never: infinite animation, pulsing dots, spinners before 300 ms, skeleton shimmer, count-up numbers, smooth-scroll under reduced motion, anything that moves every second. Times change at minute granularity only.
- Under `prefers-reduced-motion: reduce`: `transition-duration: 0ms` and `animation: none` everywhere, except the leave fade above; `scrollIntoView` uses `behavior: 'auto'`.

## 8. Microinteraction stance

- **Press**: every button and link moves down 1px on `:active`. The filled and ink buttons darken on hover (`@media (hover: hover)` only); outline and text buttons get `--color-paper-2`.
- **Focus**: one ring for everything: `outline: 2px solid var(--color-focus); outline-offset: 2px;` on `:focus-visible`, shown instantly, never animated, never removed.
- **Hover** never reveals a control. Everything a mouse can reach on hover is visible without it (Open links, chevrons on touch). Hover only underlines or tints.
- **Copy feedback is a label swap**, not a toast: "Copy ID" becomes "Copied ✓" for 2.5 s. Long-lived guidance (paste, progress) lives in the selection bar, which stays until you close it.
- **Disabled**: `--color-paper-3` fill, `--color-muted` text, `cursor: not-allowed`, `aria-disabled="true"` (kept in the tab order when it explains itself, e.g. Open for a session ID the app cannot open).
- **Busy**: the button keeps its label and gets `aria-busy="true"`; no spinner.
- **Checkboxes** are native, `accent-color: var(--color-ink)`, with a 44px hit area; group checkboxes are tri-state (`indeterminate`).

### 8.1 Control kinds

| kind | class | look | at most |
|---|---|---|---|
| filled | `.btn.btn--fill` | accent fill, on-accent text, 700 | one on the page: the lede's Open |
| ink | `.btn.btn--ink` | ink fill, paper text, 700 | the selection bar's main action |
| outline | `.btn.btn--line` | transparent, rule-strong border | secondary actions (Copy again, Reload, Clear filter, Review them) |
| text | `.textbtn` | 13px ink-2, underlined in rule-strong | language, ?, Clear selection, Copy ID, Show only these, Overview |
| link | `a.row__open` | 13px ink-2, "Open ↗" | one per row |

A `kbd` appears inside a control only on the lede's Open (`Enter`), the selection bar's Copy instruction (`c`), the filter field (`/`), the Overview toggle (`z`) and the no-match Clear filter (`Esc`). It is a visual hint only (`aria-hidden`; the key goes in `aria-keyshortcuts`), and the single-character ones hide while single-key shortcuts are off. The footer and the `?` dialog carry the other keys.

## 9. Voice (copy rules for both languages)

1. **One name per pile, everywhere** (ledger, pile head, tab title, notifications, help, Overview): 返事待ち / 止まったかも / 未読 / 作業中 / 最近 / 片付け; Needs you / Stuck? / Unread / Working / Recent / To archive.
2. **Labels are nouns or plain verbs. Buttons are 1 to 3 words, verb first** (Open, Copy instruction, Clear selection). Past tense only in notices ("9 of 14 archived").
3. **One sentence says what happened and what to do next.** Numbers first and exact.
4. **Every time carries its state word**: 「2 時間待ち」 "waiting 2 h", 「40 分前に停止」 "stopped 40 min ago", 「3 時間動きなし」 "quiet 3 h", 「12 分前に終了」 "done 12 min ago". Minutes, hours, days; never ticking seconds (seconds appear only in the stale notice).
5. **Content is quoted, never translated**: titles, questions, summaries, error text and folder names pass through. Inline content sits in quotes written in the template (『』 in Japanese, “ ” in English); a whole question body is a `<q>` element.
6. **No separator chains.** Meta items are separated by space (CSS `column-gap`), lists by 「、」 / ", ", sentences by 「。」 / ". ". One `·` is never used as a joiner.
7. **No metaphor in functional copy**: no "edition", "desk", "tray", "shelf" in errors, loading or buttons. (The product name is the only metaphor.)
8. **Never**: "!", emoji, praise (お疲れさま, Great job), apologies (申し訳ありません, Oops), "AI", "smart", 「〜しましょう」, internal words (盤面, epitaxy, formatSuspect, reason codes), personal paths, shell-specific syntax in the UI. The only commands shown are the ways to start the board: `npx pigeonholes`, and `npm start` in a clone.
9. English is 1.5 to 3 times longer than Japanese. Buttons never wrap to two lines; their parent row wraps instead.
10. "Claude" appears only descriptively ("paste it into Claude", "the Claude app"). The disclaimer says the tool is unofficial.

## 10. Identity

- **Name**: Pigeonholes (npm package and bin `pigeonholes`). Never "Claude" in the name, logo or page title.
- **Wordmark**: a 2×3 cabinet glyph (six 6×3.5 cells in a 16-unit box, 1px ink strokes) followed by "Pigeonholes" in `--font-display` 600 at `--text-md`. The top-left cell fills with `--color-accent` while anything needs you. The same glyph, the same layout, is the favicon (ui.md §13) and its cell order matches the ledger and keys 1 to 6 (left column: Needs you, Stuck?, Unread; right column: Working, Recent, To archive).
- **No other logo**, no sparkle, no Claude orange, no warm cream paper.

## 11. The never list

- Cards, boxed rows, card-in-card, drop shadows, glows, gradients, glass, dotted-grid backgrounds.
- Side stripes or coloured left borders on rows.
- Pills, chips, badges, tags on rows; per-row state icons that repeat the pile name (the only row mark is the next-item square and the cursor triangle).
- Traffic-light palettes or any second state hue. The accent is the only colour.
- KPI tiles, big-number stat grids, bar-like strips, barcode-like mark fields.
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
