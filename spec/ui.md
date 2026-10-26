# Pigeonholes: screen spec (v0.2)

Status: locked for v0.2 (v0.1 plus: what each session is doing, its context size, the hand-off guide and the canvas view; the v0.1 Overview is retired, the canvas far zoom does its job). The look (tokens, type, motion, voice) is `spec/design.md`. Classification and the API are `spec/board.md`. This text is the source of truth for the screen. Rules that came out of design review: Open is never hover-only, every time carries its state word, the paste step is the headline after copying, diagnostics sit behind a toggle, the board never sends or presses anything (the hand-off is a copied instruction and an Open).

Contents: 1 files · 2 page skeleton · 3 layout by width · 4 masthead · 5 the first 3 seconds · 6 counts ledger · 7 board notices · 8 piles and rows · 9 detail panel and the hand-off guide · 10 the canvas (10.11 decided while building) · 11 filtering · 12 cleanup flow · 13 notifications, favicon, tab title · 14 keyboard · 15 focus and re-rendering · 16 updates and time · 17 language · 18 first run, help, footer · 19 copy deck · 20 data from /api/board v2 · 21 tests and acceptance.

---

## 1. UI files

Every file is under 400 lines, `// @ts-check`, vanilla ESM, no dependencies. Only `api.mjs` calls `fetch`. Nothing uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `style` attributes (CSSOM `style.setProperty` is fine). Modules marked **pure** touch no DOM, no storage and no clock at import time and are tested with `node --test`. Browser modules import shared code as `../src/shared/constants.mjs` and `../src/shared/i18n.mjs` (served at those paths).

| file | role | main exports |
|---|---|---|
| `public/index.html` | static skeleton (§2), English first paint, `data-i18n` hooks, `<meta name="pigeonholes" content="1">` | — |
| `public/tokens.css` | design tokens, byte for byte from design.md §3 (with the canvas tokens) | — |
| `public/style.css` | base, controls, masthead, front (lede, ledger), page grid, banners, footer, dialogs, motion and reduced motion | — |
| `public/source-filter.css` | combined Claude Code / Codex CLI source selector and narrow masthead layout | — |
| `public/rows.css` | pile heads, rows, row detail, family tree, Working two-column rule, the doing line, the context words, the hand-off guide | — |
| `public/codex-status.mjs` | **pure** Codex, Copilot, and OpenCode source counts and safe zero-count explanations for the diagnostics footer | `codexStatusMessages()`, `copilotStatusMessages()`, `openCodeStatusMessages()` |
| `public/tidy.css` | the To archive pile: steps, select-all, groups, sub-groups, cleanup rows, selection bar | — |
| `public/canvas.css` | the canvas view (§10): page grid, front strip, viewport, sheets, running heads, slips, the band line, the Only-to-archive block, tick, the measuring box, levels, the canvas bar | — |
| `public/app.mjs` | boot: resolve language and view, load prefs, build static text, wire one delegated `click`/`change` listener, `keys.mjs` and `canvas-input.mjs`, start the poll loop (`poll.mjs`) and the minute tick | `init()` (runs on import) |
| `public/actions.mjs` | the list's click and key actions moved out of `app.mjs`: the cleanup copies, the hand-off guide from a row or `h`, the guide's buttons (any guide, found through `view.index`), the due walk | `copyChunk()`, `copySmall()`, `openHandoff()`, `handoffKey()`, `runGuide(btn)`, `dueNext()` |
| `public/poll.mjs` | the poll loop (§16): a fetch failure (offline, server, version) is told apart from a failure to draw a 200 board | `poll()`, `schedule()` |
| `public/api.mjs` | the only `fetch`: `GET /api/board` with `If-None-Match`, timeout, `v === 2` check | `fetchBoard(etag, timeoutMs)`, `BoardHttpError`, `BoardVersionError` |
| `public/state.mjs` | the single in-memory state object and its setters; prefs in localStorage `pigeonholes:v1:ui` (every read and write in try/catch) | `state`, `loadPrefs()`, `savePrefs()`, `setBoard()`, `pruneNew()`, `snapshot()`, `restore()`, `setCursor()`, `pick()`, `unpick()`, `startBatch()`, `reselectLeft()`, `setView()`, `storeHandoff()` |
| `public/ui-state.mjs` | **pure** selection, copy, batch, cursor and lede logic | `planCopy`, `commitCopy`, `pruneSelection`, `reselectIds`, `batchProgress`, `checkState`, `nextUp`, `cursorAfter`, `listsFromRows`, `stalePrefKeys`, `focusSignature`, `stepOf` |
| `public/render.mjs` | render orchestrator: masthead texts, front, then the list (piles) or the canvas, footer, tab title, favicon, keeping focus | `render()`, `renderTimes()` |
| `public/front.mjs` | lede (all states, and fitting it to its lines), counts ledger, the view switch and the due count, board notices, first-run legend | `renderFront()`, `fitLede()`, `renderBanners()`, `renderIntro()` |
| `public/rows.mjs` | rows of Needs you, Stuck?, Unread, Working, Recent; detail panel; family tree | `renderPile()`, `renderRecent()`, `rowEl()`, `detailEl()`, `familyTree()` |
| `public/labels.mjs` | the doing line and the context words as DOM nodes (rows, detail, canvas slips and bar share them); the detail's Doing / Step / Context rows; the time and Open elements and the content language (re-exported from `rows.mjs`) | `doingNodes(t, activity, {one})`, `contextNodes(t, context, now, opts)`, `asOfNode()`, `activityRows()`, `langOf()`, `timeEl()`, `openEl()` |
| `public/cleanup.mjs` | the To archive pile and the selection bar | `renderCleanup()`, `renderSelbar()`, `hiddenPicks()` (pure), `applyPick(el, visible)` |
| `public/handoff.mjs` | the hand-off (§9.1–§9.4): **pure** texts, eligibility and the copied state, plus the guide's DOM (used by the list detail and the canvas bar) | `handoffText`, `rescueText`, `handoffPlan`, `handoffArmed`, `dueIds`, `pruneHandoffs`, `latchHandoffs` (pure), `handoffRowEl()`, `handoffGuideEl()`, `runHandoffCopy()` |
| `public/canvas-layout.mjs` | **pure** placement (§10.4): what goes on each sheet and in which slot, the band line, the whole layout, reading order, neighbours. Re-exports `canvas-desk.mjs` and `canvas-fold.mjs`, so the screen imports this file only | `buildSheets`, `orderSlots`, `place`, `geometry`, `hasBand`, `layoutBoard`, `readingOrder`, `neighbour`, `findSlip` (+ the re-exports) |
| `public/canvas-fold.mjs` | **pure** (§10.4 steps 1, 3, 5): the urgency rank of a sheet, the columns of a new seat, the "Only to archive" block | `urgencyRank`, `colsFor`, `foldBlock`, `FOLD_KEY` |
| `public/canvas-desk.mjs` | **pure** placement on the desk (§10.4): pack (urgency order, in shelves, the shelf width that fits best), the first arrangement, settle (with the kept heights), push-down, drop, the seats record | `pack`, `arrange`, `settle`, `pushDown`, `dropSheet`, `parseSeats`, `cmpKey` |
| `public/canvas-camera.mjs` | **pure** camera math (§10.6): also the column cap of a new seat for the viewport width and where a running head is pinned (or its sheet hidden) | `levelOf`, `clampZ`, `stepZoom`, `zoomAt`, `fitRect`, `openCamera`, `revealRect`, `toWorld`, `toScreen`, `isNarrow`, `colsCap`, `headPin`, `LEAVE_PX` |
| `public/canvas.mjs` | the canvas DOM: sheets and slips kept in sync, running heads pinned (or a leaving sheet hidden), levels, the camera transform; seats storage (wide and narrow); which slips match the filter | `renderCanvas()`, `applyCamera()`, `focusSlip()`, `slipRect()`, `matchedIds()`, `loadSeats()`, `saveSeats()` (+ `canvasSig` re-exported) |
| `public/canvas-sheet.mjs` | the parts of a sheet (split out for the 400-line rule): running head, column rules, the band line, the "Only to archive" block | `headEl()`, `colRules()`, `backEl()`, `foldEl()`, `setVars()` |
| `public/canvas-fit.mjs` | the row heights (§10.4 step 4): lays each slip out in the hidden `#cv-measure` box at the near and mid text sizes and returns its height, cached by `canvasSig` | `slipHeights()` |
| `public/canvas-slip.mjs` | one slip's DOM (all three zoom levels) and its accessible name (built from its content) | `slipEl()`, `slipFlags()`, `canvasSig()` (pure) |
| `public/canvas-bar.mjs` | the canvas bar (§10.9) in its four states: default, detail, hand-off, moving a sheet | `renderBar()`, `zoomText()` |
| `public/canvas-ctl.mjs` | canvas control: cursor, opening and closing the bar (detail, hand-off, sheet), switching views, drawing, rearrange / moving a sheet, jumps; re-exports `canvas-view.mjs` | `drawCanvas()`, `switchView()`, `openBar()`, `openSheetBar()`, `closeBar()`, `rearrange()`, `placeSheet()`, `moveCanvasCursor()`, `canvasJumpTo()`, `canvasJumpPile()`, `canvasFocusFallback()` and smaller helpers |
| `public/canvas-view.mjs` | canvas state `cv` and the camera: apply, move, reveal a slip or an element, fit all / a sheet / back, zoom, resize; `quietFocus` (a focus put back after a render moves neither camera nor cursor) | `cv`, `apply()`, `moveCam()`, `reveal()`, `revealEl()`, `quietFocus()`, `fitAll()`, `fitSheet()`, `fitToggle()`, `zoomTo()`, `resized()` and smaller helpers |
| `public/canvas-act.mjs` | wiring of the canvas keys and clicks to `canvas-ctl.mjs` | `runCanvasKey()`, `CANVAS_CLICK`, `initCanvas()` |
| `public/canvas-input.mjs` | pointer, wheel, touch and keys on the canvas | `canvasKeyAction(ev, ctx)`, `canvasEscapeStep()`, `canvasTarget()` (pure), `bindCanvas()` |
| `public/keys.mjs` | keyboard map (§14), help dialog, single-key off switch | `keyAction(ev, ctx)` (pure), `bindKeys()`, `openHelp()` |
| `public/notify.mjs` | opt-in notifications | `arrivals(prev, board)` (pure), `notifyArrivals()`, `notifyState()` |
| `public/favicon.mjs` | status favicon | `faviconKind(counts)` (pure), `faviconHref(kind)` (pure), `setFavicon(kind)` |
| `public/copy.mjs` | clipboard write with fallbacks and the fallback `<dialog>`; the "Copied ✓" label swap, remembered by `data-action` + `data-id` so it survives a row rebuild | `copyText(t, text, opener)` (t: the dictionary, for the fallback dialog), `swapLabel()`, `copyButton()` |
| `public/view.mjs` | DOM helpers | `h()`, `reconcile()`, `partsToNodes()`, `announce()`, `setText()` |
| `public/format.mjs` | **pure** text: every function that makes words takes `t` first (re-exports `times.mjs` and `doing.mjs`) | `reasonLine`, `projectLabel`, `contentLang`, `parseResetTime`, `matches`, `archiveInstruction`, `prLabel`, `childrenText`, `routineHistory`, `tabTitle`, `deepLink`, `tokensText`, `doingSpec`, `doingMainSpec`, `doingText`, `agoWords`, `asOfText`, `shortDoing`, `compactedRecent`, `contextMeta`, `contextValueText`, `waitWordsKey` |
| `public/doing.mjs` | **pure** doing words (§8.4): the code phrase, the main part, the one-part form of one-line places, `asOfText`, `shortDoing` | `doingSpec`, `doingMainSpec`, `doingText`, `doingOnePart`, `doingOneText`, `agoWords`, `asOfText`, `shortDoing` |
| `public/times.mjs` | **pure** time and date words | `durationText`, `agoText`, `timeText`, `cardTime`, `hm`, `dayKey`, `dateline`, `absoluteTime`, `createdText` |
| `public/i18n.mjs` | `makeT(lang)`, `detectLang({search, saved, languages})`, `DICT = {en, ja}` | — |
| `public/dict-en.mjs` | English dictionary (§19), one key per line; takes in `dict-en-canvas.mjs` and `dict-en-handoff.mjs` | `EN` |
| `public/dict-en-canvas.mjs` | English §19.9 (canvas), split out for the 400-line rule | `EN_CANVAS` |
| `public/dict-en-handoff.mjs` | English §19.13–§19.15 (doing, context, hand-off), split out for the 400-line rule | `EN_HANDOFF` |
| `public/dict-ja.mjs` | Japanese dictionary (§19), one key per line; takes in `dict-ja-canvas.mjs` and `dict-ja-handoff.mjs` | `JA` |
| `public/dict-ja-canvas.mjs` | Japanese §19.9 | `JA_CANVAS` |
| `public/dict-ja-handoff.mjs` | Japanese §19.13–§19.15 | `JA_HANDOFF` |

`public/overview.mjs` and `public/overview.css` (v0.1) are removed with the Overview; so are `prefs.overview` and `prefs.overviewQuiet` (dropped on load). New prefs (same key `pigeonholes:v1:ui`): `view` (`'list' | 'canvas'`, §10.1) and `handoff` (`{[sessionId]: {at, pct}}`, §9.2). The canvas seats live under their own key `CANVAS_STORAGE_KEY` (§10.4). Every module stays under 400 lines (checked by `npm run arch`, rule 7); split a helper module out rather than grow one past it. Dictionary parts are `public/dict-<lang>-<part>.mjs`, taken in by `dict-<lang>.mjs` (a test checks that no key is in two parts).

The server serves every file in `public/` by name (board.md §12), so no allowlist edit is needed when a file is added.

## 2. Page skeleton (`index.html`)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="pigeonholes" content="1">
  <title>Pigeonholes</title>
  <link rel="icon" href="data:image/svg+xml,…plain cabinet…">
  <link rel="stylesheet" href="/tokens.css"> <!-- then style.css, rows.css, tidy.css, canvas.css -->
  <script type="module" src="/app.mjs"></script>
</head>
<body>
<div class="board" id="top" data-view="list">     <!-- data-view: list | canvas (§10.1) -->
  <header class="masthead">wordmark · trust · dateline · demo · filter · language · ?</header>
  <div id="banners"></div>                      <!-- board notices, §7 -->
  <section class="front" id="front">lede (h1) + counts ledger (nav) + view switch + due count</section>
  <main class="pages" id="pages">               <!-- hidden in the canvas view -->
    <div class="page page--now">needs_you · div.side (trouble, unread) · working</div>
    <div class="page page--archive">div#intro (first-run legend, §18) · recent · cleanup · div.selbar</div>
  </main>
  <section class="canvas" id="canvas" aria-labelledby="cv-h" hidden>   <!-- §10; hidden in the list view -->
    <h2 class="vh" id="cv-h" data-i18n="view.canvas"></h2>
    <div class="canvas__viewport" id="cv-view" role="group" tabindex="0" data-level="mid" aria-describedby="cv-keys"><div class="canvas__world" id="cv-world"></div></div>
    <div class="cbar" id="cv-bar" role="region"></div>
  </section>
  <footer class="foot" id="foot"></footer>       <!-- hidden in the canvas view -->
</div>
<p class="vh" id="live" aria-live="polite"></p>
<p class="vh" id="title-keys" data-i18n="row.keysHint"></p>   <!-- the description of every row title (§8.3) -->
<p class="vh" id="slip-keys" data-i18n="canvas.slipKeys"></p>   <!-- the canvas slip titles' keys (§10.3) -->
<p class="vh" id="head-keys" data-i18n="canvas.headKeys"></p>   <!-- the running heads' keys (§10.3) -->
<p class="vh" id="cv-keys"></p>   <!-- the viewport's keys: canvas.keys, or canvas.keysOff with single-key shortcuts off (§10.8) -->
<dialog id="help"></dialog>
<dialog id="fallback"></dialog>
<noscript>Pigeonholes needs JavaScript.</noscript>
</body>
</html>
```

- The HTML ships English text with `data-i18n="key"` and `data-i18n-attr="placeholder:filter.placeholder;aria-label:filter.label"`; `applyStaticText()` fills them on boot and on every language switch.
- One `h1` (the lede title). Each pile is `<section aria-labelledby>` with an `h2` head; rows are `<ol>` items. Cleanup groups are `<section>` with an `h3`.
- The wordmark glyph is inline SVG (six `rect`s, `aria-hidden`); the top-left rect gets class `is-on` while Needs you > 0.

## 3. Layout by width

Breakpoints: 24rem (384px), 40rem (640px), 60rem (960px), 75rem (1200px). Every grid track is `minmax(0, …)` and every grid child has `min-width: 0`. No horizontal page scroll at any width (`html, body { overflow-x: clip }`).

| width (example) | masthead | front | piles | selection bar |
|---|---|---|---|---|
| ≥ 75rem (1280) | one line: wordmark, trust line, dateline, demo label, filter (max 20rem, pushed to the end), language, ? | lede `2fr` beside the ledger `1fr` (single column, hairlines, total line) | three columns. Left: Needs you, then Working. Middle (hairline on its left): Stuck?, then Unread. Right page `1fr` (hairline on its left): Recent, To archive. When Stuck? and Unread are both empty the middle column goes away (`.side[hidden]`, `.page--now.is-solo` is one column) and the first visible pile in each column starts at the same height | sticky at the bottom of the right page |
| 60–75rem (1024) | same | lede `7fr`, ledger `5fr` | two pages. Left: Needs you, Stuck?, Unread, Working. Right: Recent, To archive | sticky at the bottom of the right page |
| 40–60rem (768) | wordmark, dateline, demo label, filter, language, ? (trust line moves to the footer only) | lede, then the ledger as 2 columns × 3 rows in column flow (no total line) | one column in the fixed order | sticky at the bottom of the viewport over the whole page (`.page--archive { display: contents }`) |
| 24–40rem (400, Claude's side pane) | wordmark, filter, language, ? (dateline hidden; the demo label sits just under the double rule at its end, in the front's top padding, so it takes no room, moves no row and never sits on the rule; the canvas puts it in its bar instead; the footer also says demo) | same as 768 | one column, gutter 16px | as 768, at most 2 lines tall: lead + buttons; the how-to line is hidden; the copied text is a closed `<details>` |
| < 24rem (320) | wraps: row 1 wordmark … language ?; row 2 the filter at full width (the demo label as at 400) | same | same; a row's Open moves to its own line so the meta links keep the full width | one column: lead, then the buttons |

- At 400×800 the first Needs-you row starts at or above 520px (target: about 490px), on the first run too (the first-run legend is not on the row path, §18). The front never gets a second lede, a prose summary or a strip of marks below 40rem.
- Pile heads are `position: sticky; top: 0` with `--color-paper` behind them. `html { scroll-padding-top: var(--head-h); scroll-padding-bottom: var(--bar-h, 0px) }` keeps a focused or cursor row out from under a head or the bar (WCAG 2.4.11). `--head-h` is the height of the tallest visible pile head (one ResizeObserver on every head); when no head is visible the property is removed so the CSS default (3.25rem) applies, never 0. The selection bar has an opaque background; nothing shows through it.
- No side column is sticky.
- This table is the list view. The canvas view has its own page grid and widths (§10.2); the masthead is the same in both.

## 4. Masthead

Left to right: wordmark link (`href="#top"`, aria-label `mast.home`) · trust line (`mast.trust`, ≥ 60rem) · dateline (`date.asOf`, ≥ 40rem) · demo label (`mast.demo`, only when `stats.demo`; in the line from 40rem; below it just under the double rule at its end, and in the canvas bar on the canvas) · filter (`input type=search`, visually hidden label `filter.label`, placeholder `filter.placeholder`, a `kbd` "/" inside the field's end) · language text button (§17) · "?" text button (aria-label `mast.help`, opens the help dialog). A 3px double rule closes it. It is not sticky.

The dateline is the time of the last successful fetch (200 or 304), rewritten only when the minute changes: `Sun 18 Oct, as of 14:52` / `10 月 18 日 (日) 14:52 時点` (own templates, no Intl). When the last success is older than `STALE_AFTER_MS` (15 s), it becomes `date.stale` (`data from 40 s ago` / `40 秒前の内容`), using short units with seconds.

## 5. The first 3 seconds (the lede)

`nextUp(board)` (pure) picks the lede card: the first card of `buckets.needs_you` (oldest wait), else of `trouble`, else of `unread`. The lede ignores the text and family filters. Its row in the list is marked `.is-next` (accent square in the mark column, accent time). The lede's Open is the only filled button on the page.

| state | h1 | line under (accent, 700) | quote / reason | action row |
|---|---|---|---|---|
| **busy** (needs you ≥ 1) | `lede.answer` | `lede.waiting` (`_now` under 1 min), long units | none: the question is the first Needs-you row's, right below (built as `p.lede__q` and hidden, so it is said once) | [`open.text` `Enter`] filled + `lede.more.needs_you` when more than one |
| **only stuck** (needs you 0, stuck ≥ 1) | `lede.check` | `lede.stalled` (timeKind stalled) or `lede.stopped` / `_now` | none (the row's `reasonLine`, as above) | [`open.text` `Enter`] + `lede.more.trouble` |
| **only unread** (needs 0, stuck 0, unread ≥ 1) | `lede.read` | `lede.ended` / `_now` | none (the row's body, as above) | [`open.text` `Enter`] + `lede.more.unread` |
| **quiet** (all three 0) | `lede.calm` in ink-2, weight 400 | — (nothing in accent) | `lede.calmSince` (omitted if unknown) + `lede.calmWorking` or `lede.calmIdle` | if cleanup > 0: [`lede.calmCleanupBtn`] outline, jumps to To archive + `lede.calmCleanup` |
| **loading** (no data yet, first fetch in flight) | `lede.loading` | — | `lede.loadingNote` | none. The ledger shows "–" for every count. Piles show three empty ruled rows. No spinner, no shimmer |
| **first run** | as the data says | | | the legend appears once at the top of the archive page (§18) |
| **empty** (`counts.active === 0`) | `lede.empty` | — | `lede.emptyNote` | none. Piles hidden; footer shown |
| **offline, data shown** | unchanged (last data) | | | banner `banner.offline` above (§7); dateline shows `date.stale`; tab title gets `app.tabOffline`; Open still works |
| **offline, never loaded** | `lede.offline` | — | `lede.offlineNote` with `{cmd}` = a `<code>` "npx pigeonholes" (via `partsToNodes`); the sentence also names `npm start` for a clone | none. Polling continues; the board appears by itself |
| **draw failed** (a 200 board could not be drawn) | unchanged (the previous data), or a visually hidden `h1` with `banner.render.lead` when there is none | | | banner `banner.render` (§7); the state goes back to before that board, the ETag is not taken (the next poll tries again) and the error goes to the console. Never reported as offline |
| **server error (500), no data** | `lede.serverError` | — | `lede.serverErrorNote` | none. With data: banner `banner.server` instead |
| **version mismatch** (`v !== 2`) | unchanged (or empty) | | | banner `banner.version` with [Reload]; polling stops |
| **format suspect** | as the data says | | | banner `banner.format.*` above the lede and again at the top of To archive (§12) |

- `lede.calmSince`'s `{time}` (HH:mm) is when Needs you + Stuck? + Unread last became 0, stored per local day in prefs `zeroSince` (try/catch; unknown → the sentence is left out).
- Quiet removes every accent: the lede, no `.is-next` row, the wordmark cell, the favicon. No praise.
- Long titles (> 40 characters) add `.lede--long` (cap at `--text-lg`). The sentence fits 3 lines (2 in the canvas strip) with its frame words kept: `fitLede(el, lines)` shortens only the quoted title (code points, then `…` right before the closing quote) until the `h1` fits, and then gives the `h1` the full sentence as its `aria-label`. It runs on every render and when the lede's width changes (one `ResizeObserver`); the CSS line clamp stays as the fallback.

## 6. Counts ledger, the view switch and the due count

A `nav` (aria-label `ledger.aria`) of six links in the fixed order Needs you, Stuck?, Unread, Working, Recent, To archive: `label …dotted leader… number`. Each link scrolls to its pile, opens it if collapsed (Recent, To archive) and puts the cursor on its first row (same as keys 1–6).

- Needs you, Stuck? and Unread with a count > 0 are bold ink (`.is-act`). A zero count stays in place in `--color-muted` (`.is-zero`); the layout never jumps. No accent in the ledger.
- ≥ 60rem: 2 columns × 3 rows (column flow) under an ink rule, hairlines between the items of a column, then the total line `ledger.total` with the number `counts.active` (`ledger.totalNoArchived` when nothing is archived) across both columns, closed by the double rule. (One column of six made the ledger twice as tall as the lede.)
- < 60rem: 2 columns × 3 rows (column flow), no total line.
- While a text or family filter is active, every number is the matched count and the total line reads `ledger.match`.
- **Under the ledger** (start-aligned, one line, wraps as a whole): the view switch, then the due count.
  - **View switch**: a text button `view.canvas` + `kbd` v (`aria-keyshortcuts="v"` while single-key shortcuts are on). It switches to the canvas (§10.1). The canvas front strip ends with the same button reading `view.list`.
  - **Due count**: a text button `ctx.dueCount` (`{n}` = cards at the `due` or `soon` level that can be handed off now: those with a guide in §9.1, so Unread and Recent with a context and Stuck? with the rescue guide; Working, Needs you and Stuck? at the limit wait and are not counted), shown only when `n > 0`. Each press moves the cursor to the next of `dueIds(board)` (highest `pct` first, ties by ID, wrapping), opens nothing, scrolls the row into view and focuses its title, exactly as `j` would. No accent, no count in the ledger, no banner: a full session is not urgent the way Needs you is.

## 7. Board notices (banners)

Rendered in `#banners`, above the lede, in this order. Each is a `p.banner`: a bold lead sentence (`*.lead`, ink, 16px) then the rest (13px, ink-2), an ink rule above and a hairline below. No boxes, no fills, no icons.

| notice | when | text | control |
|---|---|---|---|
| version | `api.mjs` threw `BoardVersionError` | `banner.version.lead` + `banner.version.text` | [`banner.version.btn`] outline → `location.reload()` |
| offline | fetch failed (network, timeout) and data exists | `banner.offline.lead` + `banner.offline.text` | — |
| draw failed | `setBoard` or `render()` threw on a 200 board | `banner.render.lead` + `banner.render.text` | [`banner.version.btn`] outline → `location.reload()` |
| server | HTTP 5xx and data exists | `banner.server.lead` + `banner.server.text` | — |
| format | `stats.formatSuspect` is set | `banner.format.lead` + `banner.format.<code>` | — |
| family | a family filter is active | `banner.family` | [`banner.clear`] text button |
| filter | a text filter is active and something matches | `banner.filter` | [`banner.clear`] text button |
| no match | the filters match nothing | `nomatch.query.lead` + `nomatch.query.text` (or `nomatch.family`) | [`nomatch.clear` `Esc`] outline |

When the kind of failure changes (to offline, server, version or draw failed), its lead sentence is announced once in `#live`.

## 8. Piles and rows

### 8.1 Pile heads

`h2.pile__head` (sticky): name (display 600, `--text-md`) and count (body 400, ink-2), on an ink rule; under it the verb line (`bucket.<key>.verb`, 13px, ink-2). Needs you, Stuck?, Unread and Working are not collapsible and are hidden when empty (the ledger still shows 0). Recent and To archive heads are `button.pile__toggle[aria-expanded]` with a chevron; their open state is remembered (`prefs.open.recent` default false, `prefs.open.cleanup` default true). A collapsed pile shows `bucket.match` in its head while filtering.

### 8.2 Ordering and truncation

| pile | order (server) | shown | body | time cell |
|---|---|---|---|---|
| Needs you | oldest wait first (`since` ascending) | **all**, never truncated | the question (`body`) as `<q lang>` in the display face; `body === ''` → `ask.<reasonParams.ask>` in ink-2 | `time.waiting` |
| Stuck? | oldest first | **all**, never truncated | `reasonLine(t, card)` | `time.stalled` or `time.stopped` |
| Unread | oldest first | first `PREVIEW.unread` (8), then [`list.more`] | body, 2 lines | `time.ended` |
| Working | newest write first (`since` descending) | first `PREVIEW.working` (8), then [`list.more`] | the doing line (§8.4), 1 line, ink-2; none when `activity` is absent | `time.running` when `startedAt` is present, else `time.updated` |
| Recent | project groups, newest group first, "No project folder" last; inside, newest first | collapsed by default; when open, `PREVIEW.recentGroup` (5) per group, then [`list.more`] | body, 1 line | `time.ago` |
| To archive | reason groups in fixed order (§12) | groups; > 20 rows → project sub-groups, collapsed; `PAGE_SIZE` (20) per page then [`page.more`] | `reasonLine(t, card)` | `time.ago` (routine rows: `time.latest`) |

[`list.more`] expands in place and becomes [`list.less`]; the expansion is remembered per list (`prefs.more`). While filtering, previews and pages are off and every match shows (§11).

Collapsed Recent shows a peek line under the verb: `{project} {n}` for each group, space-separated, muted ("No project folder" muted).

### 8.3 Row anatomy (Needs you, Stuck?, Unread, Working, Recent)

```
li.slot > div.row[data-id]           (grid: mark | title | time)
  span.row__mark (aria-hidden)       accent square on .is-next; ink triangle on .is-cursor (≥ 40rem in the margin column)
  button.row__title                  aria-expanded, aria-controls=d-<id>, aria-describedby=title-keys (row.keysHint: Enter opens, Space shows details); title (2-line clamp) + zero-width chevron
  span.row__time > time[datetime]    state word + duration, 13px, nowrap, tabular; .is-next → accent 700
  p.row__body > span.t               body / reason (2-line clamp; 1 line in Recent); in Working the doing line (§8.4, 1 line)
  p.row__meta                        13px muted items separated by column-gap (below)
  a.row__open                        "Open ↗", always visible (bottom right of the row)
  div.row__detail#d-<id> (inert)     §9, built on first open
```

- **Title**: 700 in Needs you, Stuck?, Unread; 400 in Working and Recent. Empty → `untitled`. The title's `.t` gets `lang` from `contentLang(title)` when it differs from the UI language. Clicking the title (or Space) toggles the detail; the body unclamps in place when open.
- **Open**: `a.row__open` with `href = deepLink(id)` (`claude://claude.ai/epitaxy/<id>`), text `open.row`, `aria-label` `open.aria`, `title` `open.title` (`open.demoTitle` in the demo, whose IDs do not exist in the app), a `::before` overlay for a 44px target. Ink-2 13px in every pile (accent on `.is-next`). It is never hidden by hover, opacity or `display`. When the ID does not match `SESSION_ID_RE`: no `href`, `aria-disabled="true"`, muted, `title` `open.disabled`.
- **Meta items** (in this order, each only when present): project (`projectLabel`; "No project folder" muted, `title` = `project.otherGloss`; left out inside Recent groups) · parent link `family.parent` (`button.link` → family filter; `family.parentMissing` when `parentTitle === null`, `untitled` when `''`) · children `family.childrenWith` / `family.children` (`button.link` → family filter; parts with count 0 left out, joined by `sep.list`) · open PRs only, up to `MAX_PR_BADGES` (2), `prLabel` · routine `routine.runs` (+ on the latest run when `stalled ≥ 2`: `routine.flaky` in ink) · Working with `reason === 'background'`: `reason.background`; `reason === 'starting'`: `reason.starting` · Working quiet hint `row.quietHint` in ink-2 when `now − since > QUIET_HINT_MS` (5 min) · `badge.new` for `NEW_BADGE_MS` (60 s) after the row arrived in Needs you, Stuck? or Unread (not on first paint) · `row.copied` when its ID is in the copied set · Stuck? with `activity`: `asOfText` (§8.4), muted · the context words (§8.5) · the hand-off control or words (§8.5).
- **Cursor row** (`.is-cursor`): `--color-paper-2` band and the margin triangle. **Next row** (`.is-next`): the accent square. No other row decoration: no stripes, tags or per-row state icons.
- **Arrival**: a row newly in Needs you, Stuck? or Unread (bucket+id pair not in the previous board) gets `.is-new` (the arrive primitive) and the `badge.new` word.
- Working rows use `--space-xs` padding and a muted time. When the Working pile is at least 44rem wide (container query), its rows flow in two columns.
- Rows below the fold in To archive use `content-visibility: auto; contain-intrinsic-size: auto 4.5rem` (300-row case).

### 8.4 The doing line (`Card.activity`)

What a session is doing, from the last tool use in its transcript tail (board.md §5.1). The words are this dictionary's (`doing.*`, §19.13); the board sends a kind code and a short safe target. Unread and Recent rows never show it (they stay calm); it is in their detail (§9).

- **`doingSpec(a)`** (pure) → `{key, params}` for the code phrase: `edit` → `doing.edit` with `{target}`, else `doing.edit_bare`; `write` → `doing.write`, else `doing.edit_bare`; `read` → `doing.read`, else `doing.read_bare`; `search` → `doing.search`; `run` → `doing.run`, else `doing.run_bare`; `test` → `doing.test`, else `doing.test_bare`; `git` → `doing.git`, else `doing.git_bare`; `web` → `doing.webHost` with a target, else `doing.web`; `browser` → `doing.browser`; `connector` → `doing.connector`, else `doing.connector_bare`; `agents` → `doing.agents` with `{n}` when `n ≥ 1`, else `doing.agents_bare`; `plan` → `doing.plan`; `wrap_up` → `doing.wrap_up`; `think` → `doing.think`; `tool` and any unknown kind → `doing.tool`.
- **`doingMainSpec(a)`** → `doing.note` with `{note}` when the kind is `run`, `test` or `git` and `a.note` is present (Claude's own description of that command), else `doingSpec(a)`.
- **The line** (`doingNodes(t, a, {one})`, `labels.mjs`): `doing.step` with `{step}` when `a.step` is present, then the main part, separated by `column-gap` (never `·`). `{target}` is a `<code dir="auto">` node (via `t.parts`); `{note}` and `{step}` are plain text in a `<bdi>` with `lang` from `contentLang` when it differs from the UI (both isolate their direction, so a stray bidi character can never turn the dictionary's own words around). 1 line, clamped, ink-2. **One-line places** (the Working row, the canvas mid slip) show one part, not both cut in half (`doingOnePart(a)`, pure): the main part when it is specific (Claude's note, a target, or `doing.agents` with `n`), else the step when present, else the main part. Both parts stay in the row's `title`, the open row, the detail (rows 2 and 3) and the near slip (2 lines).
- **`doingText(t, a)`** → the same line as plain text (step, a space, the main part): for `title`, `aria-label`, the filter and announcements.
- **Stuck?**: `asOfText(t, a, now)` = `doing.asOf` with `{ago}` = `time.agoPhrase` of `now − a.at` (long units) and `{doing}` = the plain main part; left out when `a.at` is missing. Muted meta item after the reason line.
- Working with `reason === 'background'` keeps `reason.background` in the meta; when `activity.kind === 'agents'` the line already says so and `reason.background` is left out.

### 8.5 The context words and the hand-off control (`Card.context`)

How full a session's context is (board.md §5.2). Words and weight only: no bar, no ring, no colour (design.md §11; the tick is canvas-only, design.md §12).

- **`contextMeta(t, ctx, now, {always = false} = {})`** (pure) → 0 to 2 meta items `{text, strong}`:
  - level `notice`: `ctx.meta` (or `ctx.metaEst` when `inferred`), muted;
  - level `due`: that, a space, `ctx.due`, as one item in ink 700; level `soon`: the same with `ctx.soon`;
  - no level (below notice): nothing, or with `always` (the canvas near level) `ctx.meta` / `ctx.metaEst`, muted;
  - `compacted` within `COMPACT_SHOW_MS` (1 h): also `ctx.compacted` with `{ago}`, muted.
- **The hand-off control** comes after the context words, from `handoffPlan(card, stored, now)` (handoff.mjs, §9.1):
  - Unread and Recent at `due` or `soon`, last active within `HANDOFF.ROW_MS` (24 h): a `button.textbtn.is-strong` `handoff.open` (`data-action="handoff-open"`, `data-id`, `aria-label` `handoff.openAria` with `{title}`, so a list of them can be told apart; the name starts with the visible word) that opens the row's detail and focuses the guide's main button (the same as `h`). When the copied state is on (§9.2): the muted word `ctx.copied` with `{ago}` instead.
  - Working at `due`/`soon`: the muted words `ctx.afterWork`. Needs you: `ctx.answerFirst`. Stuck? with `reason === 'limit'`: `ctx.afterLimit`. No button in these piles: pasting interrupts a running turn or answers a waiting question.
  - To archive: never (no tail is read for them, and the card carries no `context`).

## 9. Detail panel and the hand-off guide

Opened by the title button or Space; `grid-template-rows: 0fr → 1fr` (disclose), `inert` while closed, built on first open and kept by ID across re-renders. A changed card rebuilds its whole row; otherwise the detail is rebuilt only when `detailStamp` changes (language, the local day, and the family tree's members with their piles, titles, creation and parents), so text selected in it and a "Copied ✓" label survive other cards' updates. Its state time is a `time[data-kind]` that the minute tick rewrites. A dotted rule above, 13px, a `dl` that stacks below a 22rem container and turns into two columns (labels 5.5rem) from 22rem; the container is the pile.

Rows of the `dl`, each only when present:

1. `detail.state`: `detail.stateValue` = pile name + the row's time text (`作業中 (たった今更新)` / `Working (updated just now)`).
2. `detail.activity` (when `activity`): Working → the main part of the doing line (§8.4) and, when it shows the code phrase, the note after it as `doing.note`; other piles → `asOfText`. Kind `run`/`test`/`git` with a note always shows both the code phrase and the note here.
3. `detail.step` (when `activity.step`): the step text, plain, with `lang`.
4. `detail.context` (when `context`): `contextValueText(t, ctx)` = `detail.contextValue` with `{pct}`, `{used}`, `{window}`, `{at}` (`tokensText` of `used`, `window`, `compactAt`), then `detail.contextEst` when `inferred`, then `ctx.compacted` when `compacted` is present (any age); then, by pile, `ctx.afterWork` (Working), `ctx.answerFirst` (Needs you) or `ctx.afterLimit` (Stuck? limit) at `due`/`soon`.
5. `detail.summary`: `detail.statusDetail` as `<q lang>`.
6. `detail.error`: `detail.error` (full error, pre-wrap), for Stuck? and `old_error`.
7. `detail.branch` / `detail.worktree`; when a path-free `gitWorktree` summary exists, show its branch in preference to session metadata.
8. `detail.gitState`: clean, changed, untracked, mixed, conflicted or unknown, with counts only; `detail.gitFlags` may show locked/prunable. File names, worktree paths, common Git directory and lock reasons are never sent.
9. `detail.created`: `date.today` when today, else `absoluteTime` (`YYYY-MM-DD HH:mm`).
10. `detail.turns`: `detail.turnsValue`.
11. `detail.routine`: `routineHistory(t, routine)` (+ `routine.flaky`).
12. `detail.pr`: up to 10 lines `pr.detail` (open first; state words from `pr.state.*`, unknown states raw); a link only when `url` is non-null (`rel="noopener noreferrer"`, `target="_blank"`); `detail.prsMore` → `pr.more`.
13. `detail.related`: the family tree (below).

Actions (text buttons, one row): [`open.row`] (only in To archive rows, which have no row-level Open) · [`detail.familyOnly`] (when in a family) · [`detail.copyId`] · [`detail.copyLink`]. A copy button's label becomes `detail.copied` for `COPIED_LABEL_MS` (2.5 s); no toast.

**Family tree** (`ul.tree`, aria-label `detail.relatedAria` with the root title): built from `families[rootId].memberIds` and each member card's `family.parentId`. Cards are found across all buckets, recent groups and cleanup groups; a routine row stands for every ID in its `runIds`. Root first, children nested under their parent (by `createdAt` ascending), depth ≤ `FAMILY_MAX_DEPTH`, at most 12 nodes, then `detail.treeMore`. Each node: title + the pile name it is in (muted, right). The row's own node is bold with `detail.self`. Every other node is a `button` that jumps to its row (`jumpTo(id)`; on the canvas it moves the cursor to that slip, §10.6). Members without a card count into `detail.treeMore`.

The **hand-off guide** (§9.2) or the **rescue guide** (§9.3) sits between the `dl` and the actions row when `handoffPlan` says so; the detail of every other card shows only the words of row 4. `detailStamp` adds the copied state of this card (so a copy re-renders its guide) and nothing that changes on every poll.

### 9.1 Who gets which guide (`handoffPlan(card, stored, now)`, pure)

`stored` = `prefs.handoff[card.id]` (or undefined). Returns `{guide: 'handoff'|'rescue'|null, row: 'button'|'copied'|null, why: DictKey|null}`; `why` is the dictionary key that says why there is no guide (for `h` and the canvas bar).

| pile | guide | row / slip control (§8.5) | why (no guide) |
|---|---|---|---|
| Needs you | — | words `ctx.answerFirst` at due/soon | `ctx.answerFirst` |
| Stuck? | `rescue` when `level === 'soon'` or `detail.contextExceeded > 0` | words (`ctx.afterLimit` for `limit`) | `ctx.afterLimit` for `limit`, else `handoff.whyStuck` |
| Unread, Recent | `handoff` whenever `context` is present (any level, so an early hand-off is one `h` away) | `button` at due/soon when `now − lastActivityAt < HANDOFF.ROW_MS`; `copied` instead while `handoffArmed` is false | `handoff.whyUnknown` (no `context`) |
| Working | — | words `ctx.afterWork` at due/soon | `ctx.afterWork` |
| To archive | — | — | `handoff.whyUnknown` |

**`h`** (list and canvas) on the cursor session: when `guide` is set, open the detail (list) or the bar's hand-off state (canvas), bring the guide into view and focus its main button; else announce `live.handoffNo` with `{why}` = `t(why)`.

### 9.2 The hand-off guide (`handoffGuideEl(t, card, o)`, one builder for the list detail and the canvas bar)

`section.handoff` (aria-labelledby its lead), in this order:

1. Lead (`h3`, body 700, 16px): `handoff.lead` with `{title}` and `{pct}`.
2. `handoff.why` (13px, ink-2).
3. `ol.steps` of three: `handoff.step1`, `handoff.step2`, `handoff.step3` (the numbers in the cleanup steps' style; no "now" marker).
4. Buttons, one row (wraps as a whole): [`handoff.copyOpen`] ink (`data-action="handoff-copy-open"`, the button `h` focuses), [`handoff.copyOnly`] outline (`data-action="handoff-copy"`), and in the canvas bar [`handoff.close`] text.
5. A closed `details` `handoff.text` with the exact text in mono (`pre-wrap`), so the user can read what will be pasted. Once opened it stays open across rebuilds of the guide (Copy only changes the row state and rebuilds it; a poll may too), per card and guide kind, in the list detail and the canvas bar alike.

**Copy and open** (`runHandoffCopy({t, card, mode, button, opener, store, open})`): `text = handoffText(t, {pct: card.context.pct})`; `copyText(t, text, opener)` (clipboard API, then textarea, then the fallback dialog). Only a confirmed copy goes on: the button's label becomes `detail.copied` for `COPIED_LABEL_MS`, `#live` says `handoff.copied` with `{title}`, `store(card.id, {at: now, pct})` writes `prefs.handoff[id]`, and for `copy-open` then `open(card.id)` (`openSession`, the `claude://claude.ai/epitaxy/<id>` link). Copy first, open second: the clipboard needs the page focused. Copy only stores too. In the demo the open is skipped (the IDs do not exist in the app) and the guide shows `open.demoTitle` under the buttons.

**The copied state** (`handoffArmed(card, stored, now)`, pure): armed (the button shows) when there is no `stored`, or `now − stored.at ≥ HANDOFF.COPIED_MS` (24 h), or `context.pct ≥ stored.pct + HANDOFF.REARM_PCT` (5), or `context.compacted.at > stored.at`. The compaction is only in the tail for a while (by the time the session is due again it has scrolled out), so every new board **latches** it: `latchHandoffs(prefs.handoff, board)` (pure) drops the record of a card whose `compacted.at > stored.at` or whose `pct ≤ stored.pct − HANDOFF.REARM_PCT`, and the record is saved without it. Otherwise not armed: the row shows `ctx.copied`; the guide stays available in the detail (pressing it again is allowed: the copied text asks Claude to say so when it already handed off). `prefs.handoff` entries older than `HANDOFF.COPIED_MS` are dropped on load and save (`pruneHandoffs(map, now)`); every read and write is in try/catch. The board never learns whether the hand-off happened: the new session simply appears (Working, a child of the old one in the family tree and, on the canvas, naming its parent).

### 9.3 The rescue guide (a Stuck? session too full to answer)

Same frame as §9.2 with: lead `handoff.rescueLead` with `{title}` (or `handoff.rescueLeadCheck` when the session stopped during a tool and has no `contextExceeded` record: it may only be waiting for a permission, which its reason line says, so the lead says "if it stays stuck after you check on it"), one ink button [`handoff.rescueBtn`] (`data-action="handoff-rescue"`), then `handoff.rescuePaste` (after the button, so "paste it" follows the copy) and the closed `details` `handoff.text`. It copies `rescueText(t, {id})` and opens nothing (there is no deep link for "a new session in this folder"); it does not store a copied state. It is the one copied text that carries a session ID.

### 9.4 The copied texts (exact; keys `handoff.l0` … `handoff.l6` and `handoff.rescue.l0` … `handoff.rescue.l2`)

`handoffText(t, {pct})` joins `handoff.l0` … `handoff.l6` with `\n`; `{pct}` is the only placeholder. `rescueText(t, {id})` joins `handoff.rescue.l0` … `l2` with `\n`; `{id}` is the only placeholder. Both follow the UI language. Neither names a tool (so they survive app renames) or carries a title.

English (`handoff.l0` … `l6`):

```
This conversation's context is about {pct}% full. Please get ready to continue this work in a new session, and don't start it until I approve.
1. Stop at a safe point. While doing this, don't change files, settings or other sessions, and don't archive this session. If you already handed this work off, just tell me where and stop.
2. Write a brief for the new session: the goal, what is done, what is in progress (files, branch, uncommitted changes), decisions and why, next steps, open questions.
3. Show me the brief. Say where the new session will work (this folder or a new worktree) and whether archiving this session later would also archive the new one. Then ask me once whether to start it, with the app's new-session card if you have one, and wait.
4. Only if I approve: start one new session with a fresh context (not a fork of this conversation) and the brief as its task. If you can't start sessions, give me the brief in one code block to paste.
5. If I decline, do nothing. If I'd rather compact here, give me one line to type after /compact.
Do nothing else.
```

Japanese (`handoff.l0` … `l6`):

```
この会話のコンテキストは約 {pct}% まで埋まっています。この作業を新しいセッションで続ける準備をしてください。私が承認するまで、新しいセッションは始めないでください。
1. 区切りのよいところで止めてください。準備の間、ファイル・設定・ほかのセッションは変更せず、このセッションもアーカイブしないでください。もう引き継ぎ済みなら、引き継ぎ先だけ教えて止まってください。
2. 新しいセッション向けの引き継ぎ文を書いてください: 目的、終わったこと、途中のこと (ファイル・ブランチ・未コミットの変更)、決めたことと理由、次の手順、未解決の点。
3. 引き継ぎ文を見せてください。新しいセッションがどこで作業するか (このフォルダか、新しい worktree か) と、あとでこのセッションをアーカイブすると新しい方も一緒にアーカイブされるかも書いてください。そのうえで、始めてよいかを 1 回だけ聞いて待ってください (アプリの新しいセッションのカードが使えるならそれで)。
4. 承認したときだけ: 新しいセッションを 1 つ、まっさらなコンテキストで始めてください (この会話のフォークではなく)。引き継ぎ文をその作業内容にします。セッションを始められない場合は、貼り付け用に引き継ぎ文を 1 つのコードブロックで渡してください。
5. 断ったら何もしないでください。ここで要約したいと言ったら、/compact の後に打つ 1 行を教えてください。
これ以外のことはしないでください。
```

English (`handoff.rescue.l0` … `l2`):

```
The session {id} has run out of room in its context. Using your session tools, read its recent transcript (read only: don't message, archive or change it).
Write a brief: the goal, what is done, what is in progress (files, branch, uncommitted changes), decisions and why, next steps, open questions.
Show it to me and ask once whether to continue that work here, then wait. Do nothing else.
```

Japanese (`handoff.rescue.l0` … `l2`):

```
セッション {id} はコンテキストに余裕がなくなりました。セッションのツールで、その最近の会話を読んでください (読むだけ: メッセージ・アーカイブ・変更はしない)。
引き継ぎ文を書いてください: 目的、終わったこと、途中のこと (ファイル・ブランチ・未コミットの変更)、決めたことと理由、次の手順、未解決の点。
それを見せて、ここでその作業を続けてよいかを 1 回だけ聞いて待ってください。これ以外のことはしないでください。
```

Why each line of the hand-off text is there: l0 sets one goal and one gate; l1 stops side effects and a second hand-off (pasting twice); l2 is the brief, written while the context is still whole; l3 makes the plan visible before the approval, including the archive cascade (archiving the old session also archives finished side sessions); l4 names the one action and rules out a fork (a fork carries the same full context), with a code-block fallback; l5 gives the two other answers (Claude cannot run `/compact` itself). The approval is the user's, in the app; the board sends, approves, starts and archives nothing.

### 9.5 Decided while building (v0.2, the list)

- "N ago" phrases under one minute read as 1 minute, not seconds (no ticking seconds, design.md §7). `doing.asOf` uses the long units; `ctx.compacted` and `ctx.copied` the row's short units.
- After a rescue copy the screen reader hears `handoff.rescuePaste` instead of `handoff.copied` (which would say to paste into the stuck session). A rescue copy stores no copied state.
- `h` with no cursor uses the lede's session, as Enter does.
- The "Copied ✓" label is remembered by `data-action` + `data-id`, so it survives the row rebuild that follows a hand-off copy (Copy ID and Copy link use the same swap).
- Additive API changes: `matches(card, q, t, now?)` and `visibleModel({…, now})` search the compaction words only when `now` is passed; a `contextMeta` item may carry `ago` (for the minute tick); `contextValueText` takes `{compacted: false}`; new pure helpers `agoWords`, `compactedRecent`, `waitWordsKey` (format.mjs).
- The view switch and the due count sit together in `p.front__acts` under the ledger (it replaced the v0.1 Overview toggle).

## 10. The canvas

A second view of the same board: every session as a slip on its project's sheet, sheets laid on a free desk you can pan, zoom and rearrange. Same data, same poll, same filters, same dictionaries; nothing new is fetched. Placement is a fixed rule (§10.4), not a model: the same board gives the same picture and nothing is sent anywhere. The canvas far zoom replaces the v0.1 Overview (owner decision): there is no Overview in v0.2. The look is design.md §12.

### 10.1 Switching views

- `v` toggles list ⇄ canvas. The list has the view switch under the ledger (§6); the canvas front strip ends with it (`view.list`). `z` in the list switches to the canvas **and fits all** (the Overview's old job).
- `?view=canvas|list` opens that view without saving it. A switch by key or button saves `prefs.view` (`'list' | 'canvas'`, default `'list'`) and removes `view` from the URL with `history.replaceState`.
- `.board[data-view]` holds the view. Canvas: `#pages`, `#foot` and `#intro` get `hidden`, `#canvas` loses it. List: the opposite. Masthead, banners and the front stay.
- The cursor is a session ID and carries across. After a switch, focus goes to the cursor slip's title (canvas) or the cursor row's title (list); with no cursor, to the viewport (canvas) or the view switch (list). The list settles the cursor with `cursorAfter` on visible rows as usual (§15).
- The selection, the batch and the open details live in the list and survive a round trip. The selection bar is a list control and is not shown on the canvas.

### 10.2 Screen and widths

`.board[data-view="canvas"]` is a grid of five rows `auto auto auto minmax(0, 1fr) auto` (masthead, banners, front strip, viewport, bar) and one `minmax(0, 1fr)` column, `height: 100dvh` (fallback `100vh`), `overflow: hidden`: the page never scrolls; the viewport clips its own content.

**Front strip** (the list's front, one row at 1280, wrapping below): `h1` = the lede sentence of §5 at `--text-md` (it takes the lede's full width and fits 2 lines: `fitLede` shortens the quoted title alone, so the frame words before and after it, まず … に答える / Answer … first, always show), the accent time, the one filled Open with `kbd` Enter, the `lede.more.*` sentence (13px), the ledger as one line of six links (`name n`, bold ink when above 0 for the first three, muted when 0; a link puts the cursor on the first slip of that pile in list order and reveals it), `ctx.dueCount` (when above 0; walks `dueIds` as in the list; on the canvas it comes before the view switch, and it shows once: in the bar from 40rem, in the front strip below 40rem), then `view.list` + `kbd` v. Quiet, empty, loading, offline and error states are the list's (§5, §7) in this one row.

| width | front strip | bar | camera padding |
|---|---|---|---|
| ≥ 60rem | lede, ledger, List v | legend, hint (≥ 80rem), due count, zoom group, Fit all, Rearrange | `CANVAS.PAD_WIDE` (40px) |
| 40–60rem | lede, List v (the ledger is hidden: the running heads carry the counts) | due count, zoom group, Fit all, Rearrange; the legend on its own line at every level (the bar keeps one height) | 40px |
| 24–40rem (400–490, Claude's side pane) | lede title (2 lines, the full width: the switches never share its row), then time and Open, with the due count and List v at the right of that row when they fit (the `.lede` box is `display: contents` there), else on the row under; the "more" sentence hidden | the demo label (in the demo), zoom group, Fit all, Rearrange (they wrap; no control is lost on reflow, WCAG 1.4.10); the legend on its own line as above (first, so the demo label shares the tools' row); the bar's other states still open | `CANVAS.PAD_NARROW` (12px) |
| < 24rem | as 400; the masthead wraps as in the list | as 400 | 12px |

Below `CANVAS.NARROW_PX` (640px) the canvas is a column: new seats get one column (`colsCap`), the sheets stack (aspect 0.1), it opens at the width (about 100 % at 490px, so a slip is nearly the pane's width; the opening camera never shrinks for height there), and Fit all is the overview: it fits the stack's height too, but never below `FIT_MIN` (30 %, the far level: marks and one-line heads in a centred column; the same floor as every width, §10.6), and a longer stack is read from the top by scrolling (never shrunk to `Z_MIN`). The narrow arrangement has its own seats (§10.4 step 12), so the side pane and a wide window never overwrite each other's.

### 10.3 Sheets and slips (content)

**A sheet per project** with any card that is not To archive (`card.project.key`, the same key as the Recent groups): a `section.sheet` with an `h2` that holds the running head, then `ol.sheet__slips` (the slips in slot order), then the band line. DOM order = reading order (§10.4), so a screen reader reads sheet by sheet.

- **Running head**: a `button.sheet__head` inside the `h2` (the drag handle and the sheet's tab stop), `aria-label` `canvas.headAria` with `{project}` = `projectLabel` and `{list}` = the non-zero `canvas.part` items joined by `sep.list`, `aria-describedby="head-keys"` (`canvas.headKeys`: Enter shows the move buttons, Shift + arrows move it). Pressing it (a click without a drag, Enter or Space) opens the bar's sheet state (§10.9), so the head is a real button and a single pointer can move a sheet without dragging (WCAG 2.5.7). Visible: the name, then the counts of Needs you, Stuck?, Unread and Working (`canvas.part` per non-zero pile, space-separated; Recent and To archive are the band line's, at the sheet's foot, so no number shows twice; the label carries every pile). At far: one line, the name first (cut only when it alone is too long) and, when above 0 and when it fits beside the name, `canvas.farCount` in bold ink (`{n}` = the sheet's Needs you + Stuck? + Unread sessions: what is your turn; Working, Recent and To archive are not counted); the slips' marks say which pile. Pinned to the viewport top from the moment its sheet's top rule would cut it off, while part of the sheet is still on screen (`headPin`, §10.6; design.md §12).
- **Quiet sheet**: no Needs you, Stuck?, Unread or Working: the head and the band line only (no slips, no live area). **(other)**: "No project folder", muted name.
- **Only to archive** (`section.fold`, after the last sheet in DOM and Tab order): a project whose cards are all in To archive (faded ones too) gets no sheet. They are listed in one quiet block below the lowest sheet, at the left edge (`foldBlock`, §10.4): a running head that is one button (`data-action="canvas-back"` `data-pile="cleanup"`, the band's To archive action) with `canvas.fold`, then `canvas.foldCount` and `canvas.part` (To archive, the sessions in all of them) as two items apart (column gap, a visually hidden `sep.list` between them; never a `·`), and a visually hidden `sep.list` + `canvas.foldOpen`; then one line per project, `projectLabel` and its To-archive sessions (text, not controls), most first. It is not a seat and cannot be dragged; it is placed below the kept heights of the sheets (§10.4 step 6), so a sheet's growing and shrinking does not move it up and down. At far only its head and its top rule show (no fill, no hairlines, no double rule: never an empty box). A sheet with no slips is the same at far: its head and top rule.

**A slip per session in Needs you, Stuck?, Unread or Working**: `li.slip[data-id]` (`SLIP_W` × `SLIP_H`) positioned by `--x`/`--y`. Recent and To archive sessions are not slips (the list keeps Recent closed too): each sheet counts them on its band line, whose buttons open that pile in the list. So the canvas has one slip size, every title can wrap to 2 lines, and nothing on a sheet is a row of one-line marks.

| line | near (z ≥ 0.9) | mid (0.5 ≤ z < 0.9) | far (z < 0.5) |
|---|---|---|---|
| mark | the pile shape (design.md §12) | same | the mark only, centred |
| title | `button.slip__title`, 16px, 2-line clamp; 700 in Needs you, Stuck?, Unread; 400 otherwise; `untitled` when empty | same | visually hidden (still the focus target and the name) |
| where | branch (`code`), `worktreeName`, the first open PR (`prLabel`; without the repo when it equals the project), and `family.parent` (one line, the title cut first) when the session has a parent: the relation is said in words, never drawn | — | — |
| doing (long) | Needs you: the question as `<q lang>` (or `ask.<kind>`); Stuck?: `reasonLine` then `asOfText`, 2 lines; Unread: the body as `<q lang>`, 2 lines; Working: the doing line (§8.4), 1 line | `shortDoing(t, card)` (below), 1 line, Stuck? and Working only; not on the narrow canvas | — |
| foot (one line) | the time with its state word (§19.5) · the context words (`contextMeta`) with the tick (design.md §12) at notice or above (below it they are only in the title's accessible name); the context word is cut first when the line is full | the time · the tick and number only at notice or above; not on the narrow canvas (its mid level is the marks and the titles: it is read at 100 %) | — |
| actions (one line) | `a.row__open` "Open ↗" (always visible) · the hand-off control of §8.5 (`handoff.open` button or `ctx.copied`; Working, Needs you and Stuck? at the limit get their muted words `ctx.afterWork` / `ctx.answerFirst` / `ctx.afterLimit` at due/soon instead, as in the list, so a bold "time to hand off" is never left unqualified) | — | — |

- **`shortDoing(t, card)`** (pure): Stuck? → `short.stalled_<via>`, `short.limit`, `short.git_startup`, `short.not_started`, `short.error`; Working → `doingOneText(t, activity)` (one part, §8.4) when present, else `reason.background` / `reason.starting` / `''`; any other pile → `''` (Needs you and Unread: the mark and the time's state word, "Waiting 2 h" / "Finished 25 min ago", say it already).
- **Accessible name** of the title button, built from its content (no `aria-label`, no `lang` on the button): visually hidden spans in the UI language around the visible title, which alone carries `lang` (WCAG 3.1.2): `canvas.slipName` (`{pile}`, `{title}`), then `sep.list` and the context words when `contextMeta` gives any, and the hand-off words (`ctx.afterWork` …) when they show. While the slip does not match the filter, a hidden `sep.list` + `canvas.noMatch` is added (set in place by the render, since the filter is not in `canvasSig`). The time is not in the name: `aria-describedby` = the slip's time cell (`#st-<id>`, rewritten by the minute tick) and `slip-keys` (`canvas.slipKeys`: Enter, Space, arrows), so the name of a focused slip does not change every minute.
- **Next** slip (the lede's session): accent time and Open. **Cursor** slip: `--cv-cursor` and an ink bar on its inline-start edge (design.md §12).
- The slip is never one big click target (design.md §11): the title sets the cursor and opens the bar's detail; Open is the link; Hand off opens the bar's hand-off state.
- **Band line** (`div.sheet__back`, at the sheet's foot): one line, `BACK_HEAD` tall at every count, when the sheet has any Recent or To archive session: a text button `bucket.recent.title` + the number and one `bucket.cleanup.title` + the number (`data-action="canvas-back"`, `data-pile`), each only when its count is above 0, that switch to the list and open that pile (`jumpPile`). The numbers are sessions (a routine row's runs, faded cards), the same as the head's label, so one pile name never shows two numbers on one sheet. A sheet with no slips has the band right under its top rule, with no rule of its own. Shown at near and mid; at far the band and its rule are empty (the running head's count covers it). No titles or strokes: Recent and the cleanup workflow (pick, copy) are the list's.
- **Families**: no lines between slips and no grouping (§10.4 step 2): each child says `family.parent` on its near "where" line. The tree itself is in the bar's detail (§9 row 13).

### 10.4 Placement (`canvas-layout.mjs`, pure)

A pure function of (board, saved seats, the viewport aspect at the last Rearrange, `now`). Same input → same output, to the unit. World units are CSS px at 100 %. Constants: `CANVAS` in `src/shared/constants.mjs` (board.md §3). The text and family filters never change the layout (they dim, §10.10).

1. **Sheets** (`buildSheets(board)`): one per `card.project.key`, over every card in the buckets, recent groups and cleanup groups (a routine row is one card). **Live** = Needs you, Stuck?, Unread, Working, Recent. **Back** = To archive, except a To-archive card whose family (`family.rootId`, or itself as a root in `board.families`) has a member in a live pile anywhere on the board: it is marked **faded** (kept in the model for its family; it is never a slip). `counts` per pile (faded counted under `cleanup`), `quiet` = no Needs you, Stuck?, Unread or Working, `lastAt` = the newest `lastActivityAt` of its cards. A project with no Live card (only To archive, faded ones included) is **folded** (no sheet; §10.3 Only to archive).
2. **Order** (`orderSlots(cards, piles, faded)` → IDs, run over the sheet's slip cards: Needs you, Stuck?, Unread, Working): a member key is `[band, pileIndex, timeKey, id]` with band 0 = Needs you, Stuck?; 1 = Unread, Working; 2 = Recent; 3 = faded; `pileIndex` = the pile's index in `BUCKETS`; `timeKey` = `since` for Needs you, Stuck?, Unread (oldest first) and `−since` for Working, Recent (newest first); faded `−lastActivityAt`. Cards sort by key (lexicographic; IDs compare as strings). Families are not grouped: a child is placed by its own key and names its parent in words (§10.3), the same order as the list.
3. **Columns and slots** (`place(ids, cols)`): `cols` is fixed per seat: `colsFor(n, maxCols)` = `clamp(ceil(√n), COLS_MIN 1, maxCols)` with `n` = the sheet's slips (1 when it has none) when the seat is made, so a sheet never has an empty column; `maxCols` = `colsCap(viewport width)` (the columns that fit the viewport at `Z_OPEN`; 1 below `NARROW_PX`). Then it never changes until Rearrange (growth adds rows). Reading order, left to right, top to bottom: slip `i` gets `{col: i mod cols, row: ⌊i / cols⌋}`; `rows` = last row + 1 (0 when live is empty).
4. **Geometry** (`geometry(band, cols, rows, rowH)`): `w = cols × SLIP_W`; each row is as tall as its tallest slip (`slipHeight(slipH, id)`: the height the screen measured, `canvas-fit.mjs`, rounded up to 4 units and clamped to `SLIP_H_MIN` … `SLIP_H_MAX`; `SLIP_H` when not measured), so a short slip leaves no blank third under it; `liveH` = the sum of the rows; the band line is `BACK_HEAD` when the sheet has any Recent or To archive session (`hasBand`, 0 otherwise), whatever the count; `h = liveH + band + FOOT_H`. Area shows what needs looking at: To archive and Recent take one line.
5. **Pack** (`pack(sheets, aspect, foot, maxW)`, first run and Rearrange): sheets in urgency order (`urgencyRank`: by the sheet's most urgent pile, Needs you, Stuck?, Unread, Working, then none; at the same top pile the longest wait in it first (`wait` = the time key of that pile's first slip, as the list orders it: oldest `since` for Needs you, Stuck? and Unread, newest for Working; whether the sheet also has other piles is not compared); then "No project folder" after named projects, then the newest `lastAt`, then weight `live + back / 4` descending; ties by key); shelves: left to right from x = 0, and when a sheet does not fit in the shelf width `W` (and is not the first of its shelf) a new shelf starts at x = 0 below the tallest sheet of the shelf above (+ `GAP_Y`). `W` is the width at which Fit all shows the desk largest: of the candidates (the widths of every run of consecutive sheets in that order, and `√(Σ (w + GAP_X)(h + GAP_Y) × aspect)`), the one whose shelves, with the Only-to-archive block under them (`foot`), give the largest `min(aspect / width, 1 / height)`, the narrowest on a tie; at the narrow aspect (0.1) `W` is the widest sheet (one column). `W` is at most `maxW` = (viewport width − 2 × padding) / `Z_OPEN` (never below the widest sheet), so at the opening zoom a shelf fits the viewport and no sheet starts cut at the right edge (768px). Holes are not backfilled, so the reading order `(y, x)` is the urgency order and the urgent sheets are top left.
6. **Settle** (`settle(sheets, seatsDoc, now)`, every board): a seated sheet keeps `x`, `y` and `cols`, and takes the desk height `max(h, seat.h)`: the **kept height** `seat.h` is the tallest it has been since the last Rearrange, so a sheet that grows when a session comes back to Working pushes the sheets below it down once, and later flips (back to Recent, to Working again) move nothing (the space stays as desk under it; no new holes). New projects, in urgency order, are each placed by one skyline step (`W` from the stored aspect, at most `maxW`: candidate x = 0 and every placed sheet's `x + w + GAP_X`, skipping `x + w > W` except x = 0; the lowest y where nothing overlaps `[x, x + w + GAP_X)`, then the smallest x) against the seated ones; then `pushDown` (over the desk heights). Sheets never move by themselves, so a project that becomes urgent later stays where it is (the opening camera covers it, §10.6). Shrinking pulls nothing up (holes stay until Rearrange). A project with no cards keeps its seat while `now − seat.seen < SEAT_KEEP_MS` (7 days), so it comes back to the same place; `seen` is refreshed to `now` for every sheet on the board.
7. **Push down** (`pushDown(placed, fixedKey?)`): in order of `(y, x, key)` (the fixed sheet first when given), every sheet that overlaps an earlier one, gaps included (`GAP_X`, `GAP_Y`), moves straight down to `earlier.y + earlier.h + GAP_Y`, repeated until it overlaps none. Never sideways, never up.
8. **Drag and nudge** (`dropSheet(seatsDoc, sheets, key, x, y, now)`): `x`, `y` snap to `SNAP` (8) units and clamp at 0; the dropped sheet's kept height becomes its height (no unseen space under a sheet you placed), the others keep theirs. Then the dropped sheet D settles against each other sheet A it overlaps (gaps included): when D **covers** A from above (their rectangles overlap without the gaps and D's top is at or above A's top), A stays for push-down; otherwise (D only went into A's margin, or landed on A's lower part) D yields: it moves just out of A's margin the cheapest way (right or left of A, below A when D's top is lower, above A when D's top is higher, never below 0), and again against the next sheet it then overlaps; after `2 × sheets + 2` steps it only moves straight down (so it always stops). Finally `pushDown` with D fixed moves what D covers. So a sheet can come no closer than the gap (the margin holds the running head), a nudge into a neighbour's margin leaves both sheets where they were (`#live` says `canvas.blocked`), and a sheet goes before another when its top reaches the other's top ("drag one sheet onto another → the other moves down"). No sheet above D's final top ever moves. Returns the new seats doc. The keyboard nudge (Shift + arrows on a running head) and the bar's move buttons call it with ±`NUDGE` (32).
9. **Rearrange**: `layoutBoard(board, null, {aspect, now})` clears the seats and packs; the view then fits all; `#live` says `canvas.arrangeDone` with `{n}` = sheets.
10. **`layoutBoard(board, seatsDoc, {aspect, now, maxCols, maxW, slipH})`** → `{sheets: SheetLayout[], seats: SeatsDoc, bounds: {x, y, w, h}, fold: Fold|null}` with `SheetLayout = {key, label, project, quiet, x, y, w, h, cols, rows, liveH, counts, slips: [{id, pile, col, row, x, y, h}], back: {total, recent, y}}` (`h` = the slip's row height; `back.total` / `back.recent` = the To-archive (faded included) and Recent cards that are not slips; `slipH` = measured heights by ID, `maxW` = the shelf width cap of step 5) and `Fold = {key: FOLD_KEY, x, y, w, h, items: [{key, label, project, n}]}` (`n` = To-archive sessions; most first, ties by key; `x` = the leftmost sheet's x, `y` = the lowest sheet bottom (desk heights) + `GAP_Y`, `w = SLIP_W`, `h = items × FOLD_ROW + FOOT_H`). Slip and back coordinates are relative to the sheet's top-left; `bounds` covers every sheet and the fold. Sheets come in reading order, by `(y, x, key)`.
11. **Reading order and neighbours**: `readingOrder(layout)` → slip IDs, sheet by sheet in that order, slips in slot order (Recent, To archive and folded projects never). `neighbour(layout, id, dir)` → the nearest slip centre in that direction within the sheet (smallest primary distance, then secondary), else the nearest in the nearest sheet that way, else null.
12. **Seats doc** (`localStorage` `CANVAS_STORAGE_KEY` for viewports from `NARROW_PX`, `CANVAS_STORAGE_KEY + ':narrow'` below it; a per-viewer convenience; every read and write in try/catch; nothing leaves the browser): `{v: 3, aspect: number, seats: {[projectKey]: {x, y, cols, seen, h?}}}` (`h` = the kept height, 0 … 1e7; a seat without it uses the sheet's height). `parseSeats(raw)` returns a valid doc or null (any wrong shape, a v 1 doc from the smaller slips and a v 2 doc from the fixed-height rows → null → a fresh pack).
13. **Cost**: O(n log n) slots plus O(S²) sheets (a pack tries O(S²) shelf widths, O(S³)); a 300-session synthetic board settles in under 5 ms and packs in under 20 ms.

### 10.5 Drawing and zoom levels (`canvas.mjs`, `canvas.css`)

- The world is one element with `transform: translate(var(--tx), var(--ty)) scale(var(--z))` (`transform-origin: 0 0`), set through CSSOM. No `<canvas>`, no library. Text and rules are counter-scaled by `--k` (design.md §12); nothing is below 13px at any zoom.
- `data-level` on the viewport (`levelOf(z)`: far below `LEVEL_MID`, mid below `LEVEL_NEAR`, near from it) switches the content by CSS only; a zoom never rebuilds DOM. At far a slip shows its mark only; the fold's lines and the band line show nothing (no rules either: no ladder of empty hairlines), and a sheet with no slips and the fold block are their head and top rule only. `LEVEL_NEAR` is 100 %, so near text is never larger than at 100 % and the measured near height holds at every near zoom; `LEVEL_MID` is 60 % (the mid height is measured at that text size). Below `NARROW_PX` there is no mid level (`levelOf(z, vw)`): near starts at the opening zoom, `nearZ(vw)` = min(100 %, the zoom at which a slip fills the width; 87 % at 400px), the rows are measured at that text size only, and anything smaller is far (the overview). A narrow mid level was a near-sized cell holding a title.
- Sheets fully outside the viewport get `content-visibility: auto` with their world size as `contain-intrinsic-size`.
- Re-rendering is keyed: sheets by project key and slips by session ID (`reconcile`); a slip rebuilds only when `canvasSig` changes (language, its card, its pile and its flags: next, cursor, new, matched, copied state, joined to its parent). Position changes only set `--x`/`--y` (no animation). A slip newly in Needs you, Stuck? or Unread gets the arrive primitive. The minute tick rewrites the time cells in place (`renderTimes`; the slip names hold no time). While a sheet is dragged its position lives in `cv.drag`, so a render in the middle of a drag keeps it under the pointer.

### 10.6 Camera (`canvas-camera.mjs`, pure; applied by `applyCamera`)

`Camera = {x, y, z}`: the world point at the viewport's top-left and the zoom (`Z_MIN` 0.15 … `Z_MAX` 1.5).

- **On open** (`openCamera(layout, nextId, vw, vh, pad)`): the rectangle of the sheets that are not quiet (any Needs you, Stuck?, Unread or Working), at the zoom that fits it clamped to `Z_OPEN` (0.62) … 100 % (below `NARROW_PX` the width alone decides), aligned top-left: its top-left (heads included, `HEAD_ROOM`) at the padding, so the urgency-ordered desk is read from its top-left and no sheet starts within a head height of the viewport top on a fresh pack. When the lede's slip is then outside the view, `revealRect` pans just enough to show it. With no such sheet: fit all. The camera is not saved; seats are.
- **Fit all** (`f`, `canvas.fit`; `fitRect(bounds, vw, vh, pad)`): the bounds of every sheet and the fold (only the sheets with matches while filtering) plus `HEAD_ROOM` above the top row for the running heads, at most 100 %, centred across, top aligned. It always fits the width; it fits the height too, but never below `FIT_MIN` (0.3), so a project name and the marks stay readable and a longer desk is read from the top by scrolling (never shrunk to `Z_MIN`). Below `NARROW_PX` the opening camera decides by the width alone.
- **Pinned heads** (`headPin(top, h, head, z)`): a running head is pinned from the moment the viewport top would cut it (its sheet's top rule is less than the head's height below the viewport top) while part of the sheet is still on screen, so a sheet near the top never shows without its head or with the bottom pixels of one. The pinned box (desk behind the name, the sheet's top rule under it, one rule width wider than the sheet on each side) sits 2px above the viewport top and is always whole; slips that scroll under it go under its rule. When less than `LEAVE_PX` (20px) of the sheet would show under the box, the whole sheet is hidden (`.is-leaving`, `clip-path`, so focus stays): no half head and no sliver of the double rule at the viewport top. The open camera never puts a sheet in that band (§10.6 On open).
- **`z`** toggles fit all ⇄ the camera before it. In the list, `z` opens the canvas at fit all.
- **Zoom**: `+`/`=` and `−` step through `Z_STEPS` (`stepZoom`; below `NARROW_PX` the steps between `FIT_MIN` and `nearZ` are skipped and `nearZ` is a step, so `−` goes from the opening view straight to the overview: there is no mid level there; and no zoom, by key, wheel or pinch, goes below `FIT_MIN` there (`minZoom`): in one column a smaller zoom put the far heads on the double rule of the sheet above), around the cursor slip when it is on screen, else the viewport centre (`zoomAt`); `0` = 100 %. Around the cursor slip, the camera then pans just enough to keep that slip whole (`revealRect`; zooming in grows it past an edge). On resize the world point at the centre stays at the centre; when only the height changed (the bar gained or lost a line, as when a detail opens) a moved camera stays where it is, so the sheets do not jump.
- **Follow**: when the cursor moves (j/k, 1–6, arrows, the due count, a family-tree node), `revealRect` pans just enough to show the slip with `REVEAL_MARGIN` (24px) clear of the pinned heads and the bar; the zoom is kept. Tab onto a running head or a back-band head that is outside the viewport (above or to the left, where the browser's own focus scroll cannot reach) reveals it the same way (`revealEl`), and so does a nudge for the moved sheet's head. Every camera move is instant (design.md §7). A poll never moves the camera: a focus the render puts back (the same slip rebuilt, a moved node, the fallback) goes through `quietFocus`, and the viewport's `focusin` then moves neither the camera nor the cursor.

### 10.7 Pointer and touch (`canvas-input.mjs`)

- Drag on the desk or on empty paper → pan. Wheel → pan (Shift + wheel: sideways). Ctrl/⌘ + wheel and trackpad pinch → zoom at the pointer. Touch: one finger pans, two fingers pinch (Pointer Events; `touch-action: none` on the viewport only).
- Drag a running head by more than `DRAG_SLOP` (4px) → move the sheet (`dropSheet` on release, `#live` says `canvas.moved`); a press without a drag focuses the head and opens the bar's sheet state (§10.9: buttons that move it, the single-pointer path for dragging, WCAG 2.5.7); pressing it again closes it.
- Click a slip title → cursor + the bar's detail. Open is the link. Nothing reacts to hover except underlines.

### 10.8 Keys on the canvas (`canvasKeyAction(ev, ctx)`, pure)

The list's rules apply: ignore IME composition (`isComposing`, keyCode 229), Ctrl/Meta/Alt, text-entry targets and open dialogs; Shift only matters on named keys; the WCAG 2.1.4 off switch silences every single-character key here too (`v h f z + = − 0 j k o 1–6 / ?`), while Enter, Space, Esc, arrows and Tab keep working. The second argument carries `{keysOn, target}`, with `target` ∈ `viewport | slip | head | bar | filter | field | dialog | control | none`.

| key | where | action |
|---|---|---|
| ← ↑ → ↓ | viewport | pan `PAN_STEP` (80px); with Shift `PAN_STEP_BIG` (400px) |
| ← ↑ → ↓ | slip | cursor to `neighbour(...)` that way; the camera follows |
| Shift + ← ↑ → ↓ | running head | move the sheet `NUDGE` (32) units (the keyboard path for dragging; the single-pointer path is the bar's sheet state); the drop rule of §10.4 applies; saved; `canvas.moved` (or `canvas.blocked` when it could not move); the camera keeps the head in view |
| `Enter`, `Space` | running head | open the bar's sheet state (§10.9), focus on its first move button; again closes it |
| `j` / `k` | anywhere on the canvas | next / previous slip in `readingOrder`; the camera follows |
| `1`–`6` | anywhere | cursor to the first slip of that pile in list order; Recent (5) and To archive (6) are not slips: they switch to the list's pile; an empty pile announces `bucket.none` |
| `Enter`, `o` | slip, or no target (the cursor slip, else the lede's session) | open the session (`openSession`) |
| `Space` | slip | toggle the bar's detail for that slip |
| `h` | slip or no target | the hand-off guide for the cursor slip in the bar (§9.1), focus on its main button; Enter presses it |
| `+` `=` / `−` / `0` / `f` / `z` | anywhere | zoom in / out / 100 % / fit all / fit ⇄ back |
| `v` | anywhere | switch to the list |
| `/`, `?` | anywhere | as in the list |
| `Esc` | — | the first that applies: close the open dialog (native) → in the filter: clear it, or blur when empty → close the bar's detail, hand-off or sheet state (focus back to the slip, or to the running head for the sheet state) → move focus from a slip or head to the viewport → clear the family filter → clear the text filter |
| `x`, `a`, `c` | — | not used on the canvas (the cleanup keys are the list's) |

**Tab order**: the viewport (one stop) → each sheet in reading order: its running head, then its slip group (one stop, roving `tabindex` on the slip titles; the cursor slip holds `0`, else the first), then its band line's buttons → the Only to archive head (`.fold__head`; Tab onto it reveals it, as for a running head) → the bar's controls. No `role="application"`. The viewport is a `role="group"` (a named focusable `div` needs a role) with `aria-label` `canvas.aria` and `aria-describedby="cv-keys"`, whose text the render sets: `canvas.keys`, or `canvas.keysOff` while single-key shortcuts are off (then only the arrows work there).

### 10.9 The canvas bar (`#cv-bar`)

Full width under the viewport (design.md §12), `role="region"`, `aria-label` = its state's lead. It stays until closed (Esc or Close), as the selection bar does.

| state | content |
|---|---|
| **default** | below 40rem in the demo: `mast.demo` (bold ink) · the legend (`aria-hidden` sample marks of the four slip piles, each followed by its pile name; the tick sample followed by `detail.context`; at every level, below 60rem on its own wrapping line, so a zoom never changes the bar's height) · `canvas.hint` (≥ 80rem) · [`ctx.dueCount`] (when above 0, from 40rem) · the zoom group: [−] (`aria-label` `canvas.zoomOut`), `canvas.zoom` (`{n}` = round(z × 100)), [+] (`canvas.zoomIn`) · [`canvas.fit` `f`] · [`canvas.arrange`] |
| **detail** (Space or a title click) | the list's detail `dl` for that card (§9, two columns from 40rem), its actions row with [`handoff.open`] first when the card has a guide (it opens the hand-off state: a Tab-reachable hand-off that works with single-key shortcuts off and for a pointer at mid zoom, where the slip's own Hand off is hidden), then [`canvas.close`] text |
| **hand-off** (`h` or Hand off) | the guide of §9.2 (or §9.3) with [`handoff.close`]; when the card has no guide: `live.handoffNo` as the lead and [`handoff.close`]. From 60rem the steps are one strip and the buttons sit to the right of the lead |
| **sheet** (a press on a running head, or Enter / Space on it) | lead `canvas.sheetLead` with `{project}`, `canvas.sheetHint`, the move buttons [←] [↑] [↓] [→] (`aria-label` `canvas.move.left` …; each press moves the sheet ±`NUDGE` by the rule of §10.4 and keeps its head in view), [`canvas.sheetFit`] (fits that sheet; `z` goes back) and [`canvas.close`] |

The bar's `aria-label` is `canvas.barAria` in the default state (its legend is `aria-hidden`, so the region is not named after it), `canvas.slip` in the detail state, and the lead in the hand-off and sheet states. Opening the detail, hand-off or sheet state by key moves focus into the bar (its main control); closing returns focus to the slip title (the running head for the sheet state). Below 40rem the default state shows the zoom group, Fit all and Rearrange (wrapping); the other states use the full width and at most half the viewport height (scrolling inside).

### 10.10 Live updates, filters, focus

- Every 200 board: `layoutBoard` → render keyed by ID → seats saved when they changed. The camera never moves on a poll. The cursor follows its session ID; when it is gone, the next slip in reading order (announced once with `live.moved` when it moved pile, as in the list).
- **Filters dim instead of removing**, so nothing moves: a non-matching slip is muted, its mark keeps its pile's shape in muted (design.md §12), its title's name gets `canvas.noMatch`, and it leaves the tab order (its title gets `tabindex=-1`); a sheet with no match shows its head and band only; `j`/`k` and arrows skip non-matches; `f` fits the matches. The ledger, the front and the banners behave as in the list.
- A poll never moves DOM focus, except when the focused element was removed (then the same slip rebuilt, else the cursor slip, else the viewport) or was moved by the reorder (it stays connected but the browser drops focus to `body`: it gets focus back). `reconcile` removes the leaving elements first and moves nodes with `moveBefore` where the browser has it (which keeps focus), so a reorder moves as few nodes as possible. These focus changes never move the camera (§10.6).

### 10.11 Decided while building (v0.2)

Placement (`canvas-layout.mjs` + `canvas-desk.mjs`):

- The placement is three files (one would be about 680 lines): what goes on a sheet and in which slot in `canvas-layout.mjs`, the desk (pack, settle, push-down, drop, seats) in `canvas-desk.mjs`, and the sheet order and wait key, the column count, the sheet size and row height and the Only-to-archive block in `canvas-fold.mjs`, both re-exported by `canvas-layout.mjs`. Additions to the contract, all additive: `arrange(items, aspect, now)` (first run and Rearrange: pack plus a fresh seats doc), `findSlip(layout, id)`; `project` (`{key, label, extra}`, passed as-is to `projectLabel`) on SheetModel and SheetLayout; `piles` (ID → pile) on SheetModel; optional 4th argument of `neighbour` (`ok`: skip slips that do not match the filter).
- `counts` are sessions: a routine row counts its `runIds`, as the list does; faded cards count under `cleanup`; `back.total` and `back.recent` are the cards that are not slips. The band line shows `counts.cleanup` and `counts.recent` (sessions), the same numbers as the running head's label, not `back.*`.
- `settle` treats a vanished project's seat (kept 7 days) as an obstacle for new sheets (`cols × SLIP_W` by `SLIP_H + FOOT_H`), so a project that comes back finds its place free; `pushDown` ignores it.
- The aspect is clamped to 0.1–10 (a broken value becomes 1.6); `parseSeats` treats an aspect outside that range, or a coordinate outside 0–1e7, as a broken doc (null).
- `neighbour` across sheets: "that way" means a sheet entirely beyond the current sheet's edge; of those, the one whose rectangle is closest to the slip's centre, and in it the slip whose centre is closest. Inside a sheet the rule above holds, so a move can go diagonally (→ at the end of a row lands on the slip down and to the right).
- The seats doc is written with keys in order; `seen` is `now` on every board, so the doc changes every poll and the screen decides when to save (it compares a signature that rounds `seen` to the hour).

Drawing and input (`canvas*.mjs`):

- `canvas.mjs` is split into `canvas.mjs`, `canvas-slip.mjs`, `canvas-bar.mjs`, `canvas-ctl.mjs` and `canvas-act.mjs` (§1); `openBar` / `closeBar` live in `canvas-ctl.mjs`.
- `content-visibility: auto` sits on each sheet's slip list (the one-line band line does not need it), not on the sheet section: its paint containment would clip the running head, which sits above the sheet box.
- Narrow first layout (below 640px, Claude's side pane): with no saved seats, or on Rearrange, the sheets are packed with aspect 0.1, so they stack in one column. Once seats exist, the stored aspect is used (§10.4).
- Slip context words are built as word, tick, number, and the due/soon word in its own span. At mid only the tick and the number show (as in the mock), so they fit the cell; the full words stay at near and in the title's accessible name. The word is cut from the dictionary text at the last space before `{pct}`, so `~` and `約` stay with the number.
- `h` on a slip with no guide does both §9.1 and §10.9: it announces `live.handoffNo` and opens the bar's hand-off state with the reason as the lead and a Close button.
- The bar's `aria-label` in the default state is `canvas.barAria` (the legend is `aria-hidden`, so `help.marks` would name something a screen reader cannot reach); the detail state uses `canvas.slip`, the hand-off and sheet states their lead. The zoom percent is a `span`, not an `output`, so pinch and wheel zoom are not announced.
- Open and Hand off inside a slip have `tabindex=-1`, so a sheet's slip group stays one tab stop; Enter opens the session and `h` hands off. With single-key shortcuts off, the bar's detail state carries a Hand off button (Tab-reachable).
- `canvas-ctl.mjs` grew past 400 lines with the sheet state: the state `cv` and the camera moved to `canvas-view.mjs` (re-exported by `canvas-ctl.mjs`).
- The head box's height is measured with `.is-pinned` taken off (the pinned padding and rule made a pinned head 5px taller, so it jumped on the next render), and it sits 2 rule widths above the sheet (design.md §12).
- After Rearrange, and when the canvas opens again, `z` has no camera to go back to (`cv.before = null`): the old camera points at a layout that no longer exists, so `z` falls back to `openCamera`.
- The bar's default state does not scroll (the text buttons' 44px hit areas made it scrollable); the detail and hand-off states scroll inside, at most `50dvh` tall.
- In the canvas view `html` and `body` get `overflow: hidden` (through `:has()`): the visually hidden `#live` paragraph after the `100dvh` grid caused a 1px page scroll.
- `stalePrefKeys(prefs, board)` also returns the retired keys `overview` and `overviewQuiet`, even with no board; `loadPrefs` drops them.

Readability pass (after owner feedback "hard to read", real data in Claude's side pane and a browser):

- The first view used to be the lede's sheet at 62 %, wherever the skyline had put it (often a 1-slip sheet low on the right, next to archive-only sheets). Now sheets are packed by urgency in shelves and the camera opens on the urgent sheets from the top left (§10.4 step 5, §10.6).
- Archive-only projects are folded into one block (§10.3), and the To archive band is one line: the spine strokes and the Recent bars at far were rows of marks that meant nothing at a glance.
- (first cut) Recent and faded were one-line slips under the full slips. They became the noisiest part of the canvas (29 one-line rows against 10 slips on the owner's board, cut to one line, bright Recent and muted faded rows alternating), so the second cut below removed them.
- `SLIP_W` 264 → 432 (a 2-line title at 62 % holds about 30 Japanese characters), `SLIP_H` 192 → 176, `COLS_MIN` 2 → 1 and `cols ≤ slips` (no empty column), `BACK_HEAD` 32 → 44, `FOLD_ROW` 40, `NARROW_PX` 640 (was a constant in `canvas-view.mjs`); `SPINE_W`, `SPINE_H`, `BACK_ROWS_MAX` and `canvas.backMore` are gone. The seats doc is v 2 so saved v 1 arrangements (made for the small slips) are dropped once.
- The narrow canvas has its own seats key, and a change of width class across `NARROW_PX` reloads that class's seats and opens the camera again.
- The strip's `h1` takes the lede's width; with a 2-line clamp on the whole `h1` the verb was the first thing lost at 490px.

Readability pass, second cut (a review of the first cut on real data):

- Only Needs you, Stuck?, Unread and Working are slips; Recent and To archive are one band line per sheet ("Recent N  To archive N", buttons to the list's piles, as the list keeps Recent closed). Faded cards are never slips; a project that has only To archive cards, faded or not, is folded. The running head shows only the four slip piles' counts (the band has the other two). A family keeps its slips together; a child whose parent is not a slip says `family.parent` on its near "where" line (`up` in the layout), so the relation is still on the canvas.
- Kept heights (`seat.h`, §10.4 step 6) replace the holes that each Recent ⇄ Working flip used to leave: a sheet grows once, later flips move nothing, and the fold block sits under the kept heights. (With one slip size and no one-line rows, a flip changes a sheet only by whole rows.)
- `pack` chooses the shelf width that makes Fit all largest (1280, real board: 23 % → 47 %); `GAP_Y` 152 → 120 (the far head is one line, about 23px, so it fits the gap down to 20 %; the box is clipped to the gap below that, never covering the sheet above). `ROW_H` is gone.
- Pinned heads: pinned whole as soon as the viewport top would cut them, with the sheet's top rule under them (the box is the sheet's top edge held in place), and the sheet is hidden when less than `LEAVE_PX` of it is left under the box (`.is-peek` is gone). The first cut's partial heads riding up with the foot, the sliver of double rule under a resting head and the half-hidden titles with no rule above them were the owner's "fragments" again.
- Connectors lie on the rows' own top rules and drop to the marks (design.md §12): the first cut's line 6 units under the sheet's ink rule read as a doubled, partial top rule. A child in a lower row is reached down the parent's mark column, 6 units below the mark (a line touching the Stuck? triangle read as an arrow).
- Below `NARROW_PX`, Fit all is now the overview (the stack's height down to 30 %, `FIT_MIN`): at 490px the opening view and Fit all were the same 100 % column, so the canvas gave no more overview than the list. The opening view stays at the width.
- `0` keeps the cursor slip whole after zooming around it. The canvas lede fits its 2 lines by shortening the quoted title (`fitLede`, §5), not by cutting it to one line (the first cut lost most of the title at 490px and left a gap before the closing bracket).
- The fold head's two counts are separated by the column gap, not a hard-coded ` · ` (design.md §9 rule 6; a test now checks that no `·` joiner is in the screen's code or dictionaries).
- The list: the lede no longer quotes the question (the first row, right below, does), the ledger at 60rem and up is 2 columns × 3 rows with the total line. Below 40rem the demo label sits under the masthead rule (the list) or in the canvas bar, not on the rule.

Readability pass, third cut (a second review, 7/10):

- Rows are as tall as their slips (`canvas-fit.mjs` measures each slip at the near and mid text sizes; the layout takes the heights as input and stays pure). One slip size left the lower third of most slips blank, worst in Claude's side pane. To keep a row from jumping as time passes, the foot and the actions are one line each and Stuck?'s long line keeps 2 lines; Working's doing line is 1 line on the slip (the list and the detail have it whole). `LEVEL_MID` 0.5 → 0.6 and `LEVEL_NEAR` 0.9 → 1, so the text size each level is measured at is the one it is shown at. The seats doc is v 3.
- Mid drops the short line for Needs you and Unread: the mark and the time's state word say the same ("Waiting 2 h", "Finished 25 min ago"), and it made the mid height the tallest. The narrow canvas has no mid level at all (§10.5): it is read at its opening zoom, and its rows were left a blank third by the mid height.
- Shelves are at most the width that fits the viewport at `Z_OPEN`: at 768px the second sheet of a shelf started cut at the right edge.
- Sheets of the same top pile go by the longest wait in it. The flags of the other piles used to come first, so a sheet with an hour-old question and some Unread went before the sheet with the day-old question the lede named.
- The far head counts only your turn (Needs you, Stuck?, Unread) and shows nothing at 0; the count of every session ("33") read as work to do. On the narrow canvas (one column) a far head may be twice the sheet's width, so a name is not cut to a few letters. At far a sheet with no slips and the Only-to-archive block are their head and top rule: an empty paper box or an empty double rule read as a broken sheet.
- No family connectors and no family grouping: on the rules the connectors read as fragments (a short drop under the rule with the run hidden by it), and keeping a family together put a Working sibling between two Needs you slips. Slips go by urgency, as in the list; every child names its parent in words.
- The legend shows at every level (below 60rem on its own line): shown at far only, the bar grew and shrank with the zoom and the viewport with it (18 to 43px). A height-only resize also keeps a moved camera now.
- The narrow strip gives the lede title the whole first row (when there was no due count, the short List link sat beside the title and cut it); the switches go at the right of the time-and-Open row when they fit.
- The narrow `−` goes from the opening view straight to 30 %: in between, with no mid level, a step showed near-sized cells holding one mark each.
- The far head keeps the name first: the count of your turn shows only when it fits beside the name (it wraps to a clipped second line otherwise). Fit all never goes below 30 % at any width (it was the narrow rule): at 768px the capped shelves made it 21 %, where no name fit.
- The dark cursor band is L 37 (1.36:1 on the sheet, was 1.16:1).
- The list's family link wraps like the words around it: on one line the parent's title was cut to a few characters. The To archive notes are one line each ("Archiving deletes nothing…", "Left out: …").

## 11. Filtering

- Client-side only. `matches(card, q, t)`: case-insensitive substring over title, `projectLabel(t, project)`, body, `reasonLine(t, card)`, the doing line (`doingText`, which holds the step and the note), and the context words (`contextMeta` texts, plus `ctx.afterWork` / `ctx.answerFirst` / `ctx.afterLimit` when they show), all in the current language. So `/` + 「引き継ぎ」 or "hand off" lists the sessions at the due level, and a file name lists the sessions editing it.
- Applies to every pile, the ledger counts and the canvas (where it dims, §10.10). Collapsed piles show `bucket.match` in the head. While filtering: previews and pages are off (every match shows), reason groups and sub-groups that contain matches open; piles with 0 matches are hidden.
- The family filter (parent/children links, [`detail.familyOnly`]) shows the root and all its non-archived descendants across piles (a routine row matches when any `runIds` member is in the family). It combines with the text filter (AND).
- Banners: `banner.filter` / `banner.family` with [`banner.clear`]. Zero matches: the no-match notice (§7) with [`nomatch.clear` `Esc`]; for the family filter alone `nomatch.family`.
- `/` focuses the field; Esc in the field clears it (a second Esc blurs). The filter text is not persisted.
- `FILTER_ANNOUNCE_MS` (0.7 s) after typing stops, `#live` reads `banner.filter` (the match count) or `nomatch.query.lead`.

## 12. Cleanup flow (To archive)

From top to bottom inside the pile (open by default):

1. **Before/after**: `cleanup.ba` with `{all}` = `counts.active`, `{left}` = active − `counts.recommended`. Left out when `counts.recommended === 0`.
2. **Steps**: `ol.steps` (aria-label `cleanup.steps.aria`): `1 cleanup.step1  2 cleanup.step2  3 cleanup.step3`. `stepOf(selected, batch)` (pure): step 1 while nothing is picked; step 2 while something is picked and not yet copied; step 3 from the first copy until the batch is closed. The current step is bold with a 2px underline on its number (+ visually hidden `cleanup.stepNow`); earlier steps are muted (+ `cleanup.stepDone`).
3. **Why**: `cleanup.why` (13px, ink-2).
4. **Select all suggested** (ink rules above and below): a tri-state checkbox `cleanup.selectAll` + tally `cleanup.tally` (picked suggested / suggested) + the definition `cleanup.def` (muted). Checking it picks every suggested row; unchecking it (from on or mixed) unpicks the suggested rows and keeps picks outside the suggestions. Hidden when `counts.recommended === 0` (always the case under `formatSuspect`); the format banner shows here instead.
5. **Reason groups**, fixed order: retried, routine_old, pr_done, old_error, old_question, idle_30d, idle_7d. Empty groups are left out. `section.group` with `h3.group__head`:
   - a group with at least one suggested row: a tri-state checkbox with the label `cleanup.<reason>` (aria `cleanup.groupAria`) + tally (picked / sessions in the group);
   - a group without suggested rows (`recommendedReason === false`, or every row has a note): no group checkbox, the name, the tally, and under it `cleanup.notSuggested` (muted).
   - Checking a group picks its suggested rows only. Unchecking (or clicking a checked or mixed box) unpicks every row of the group. `checkState(rowIds, selected)` (pure) gives `on` / `mixed` / `off`.
   - While filtering, the group and sub-group checkboxes, their states and their tallies all use the filtered rows (`applyPick(el, visible)`): rows the filter hides are never picked or unpicked by them.
   - The `h3` is named by the group name and its tally only (`aria-labelledby`); the checkbox keeps its own name `cleanup.groupAria`. The group `section` has no name, so groups are not landmarks.
6. **Sub-groups** (groups with > 20 rows come as `projects[]`): `div.sub` with a tri-state checkbox (aria `cleanup.subAria`, picks the suggested rows of that project), a toggle button (chevron, project name or "No project folder" muted, `time.moved` of its newest row), and its tally. Collapsed by default and remembered (`prefs.open['sub:<reason>:<key>']`). A collapsed sub-group that holds picks shows its tally in bold.
7. **Cleanup rows** (`div.trow`): checkbox (aria `row.selectAria`; routine rows `cleanup.routineAria`) · title button (toggles the detail, §9, whose actions include Open) · time · reason line · meta (project unless the whole group is one project; the note `note.<code>` when not suggested; routine rows `cleanup.routineTick`; `row.copied`). A picked row has the `--color-paper-2` band. A routine row's checkbox picks all its `runIds` together.

**Selection** is a set of session IDs in pick order (memory only). `x` toggles the cursor row; `a` picks every suggested row (it only adds; it never unpicks); clicks work as above. Nothing but [`sel.clear`] and unticking empties a selection: not Esc, not a key, not a re-render. IDs that leave the cleanup set (archived, or reopened and now elsewhere) drop out silently (`pruneSelection`).

**Selection bar** (`div.selbar`, `role=region`, aria-label `sel.aria`, the 3px double rule on top, opaque, sticky at the bottom, §3). It appears when something is picked or a batch is open.

| state | lead (bold) | buttons | lines under |
|---|---|---|---|
| ① picked, nothing copied | `sel.count` | [`sel.copy` `c`] ink (or `sel.copyRange` when more than 50) · [`sel.clear`] text | `sel.hidden` (picks in collapsed groups) + `sel.filtered` (picks the filter hides) + `sel.sum` · `sel.how` (≥ 40rem) |
| ② just copied, 0 archived | `sel.paste` (the next step is the headline) | [`sel.copiedBtn`] outline for 2.5 s, then [`sel.copyNext`] when chunks remain, else [`sel.copyAgain`] | `sel.progress` + `sel.checkingZero` · `details` `sel.copiedText` (open ≥ 40rem, closed below) · `sel.demo` (demo only) · `sel.permission` |
| ③ some archived | `sel.progress` | [`sel.copyNext`] or [`sel.copyAgain`] outline | `sel.checking` + `sel.now` · `sel.demo` (demo only) · `sel.permission` + `sel.cantArchive` (≥ 40rem) |
| done (all of the batch archived) | `sel.done` | [`sel.close`] text | `sel.doneSum` |
| 2 min after the last copy, some left | `sel.left` (when ≥ 1 archived) or `sel.paste` (when 0) | [`sel.reselect`] ink (only when some batch IDs are still in To archive) · [`sel.close`] text | `sel.leftWhy` (or `sel.none` when 0 archived) · `sel.demo` (demo only) |

- **Copy** (`c` or the button): `planCopy(selected, copied, COPY_CHUNK)` takes the first 50 picked IDs not yet copied; `archiveInstruction(t, ids)` writes exactly 3 lines in the UI language (`archive.line1..3`, keeping every skip rule: this session itself, still working, pinned) and then one ID per line, no titles. `copyText()` tries `navigator.clipboard.writeText`, then a selected readonly textarea + `document.execCommand('copy')`, then the fallback `<dialog>` (`fallback.title` with `{key}` = ⌘C on macOS else Ctrl+C, the selected textarea, [`fallback.confirm`] [`fallback.close`]). Only a confirmed copy calls `commitCopy` and adds the IDs to the **batch**.
- **Batch** = every ID copied since the bar was last closed, with the time of the last copy. `batchProgress(batchIds, presentIds, msSinceLastCopy)` (pure) → `{total, done, left, stale}`: `done` counts batch IDs no longer present anywhere on the board (archived); `stale` is `msSinceLastCopy ≥ SKIP_EXPLAIN_MS` (2 min). Nothing is estimated.
- **No pips**: progress is the words `sel.progress` ("9 of 14 archived"); a strip of one mark per ID would be a barcode-like field (design.md §11).
- `hiddenPicks(board, selected, prefs, visible)` (pure) → `{closed, filtered}`: picks inside a collapsed pile or sub-group, and picks the filter hides. While filtering, sub-groups are open, so their picks are not counted as closed.
- The `c` hint inside Copy instruction is `aria-hidden` (the button's name is its label; `aria-keyshortcuts="c"` while single-key shortcuts are on) and is hidden while they are off.
- Rows verified archived leave with the leave primitive. Each verified ID adds to `prefs.archivedToday` (`{day, n}`, local day) for `sel.doneSum`.
- [`sel.reselect`] replaces the selection with the batch IDs still in To archive (`reselectIds`; IDs that moved to another pile, such as the chat it was pasted into or a reopened session, are left out, and its `{n}` counts the same IDs), clears `copied` for them and starts a new batch on the next copy. [`sel.close`] clears the batch (and the selection when it is empty).
- `formatSuspect`: every `cleanup.recommended` is false, so the select-all row and the group checkboxes do not exist; rows stay pickable one by one; `cleanup.ba` is left out; the format banner sits at the top of the pile.
- Empty pile: `cleanup.empty`.

## 13. Notifications, favicon, tab title

**Notifications** (opt-in only):
- The footer button `foot.notifyOn` (+ `foot.notifyNote`) calls `Notification.requestPermission()` from the click. `notifyState()`: no button when `Notification` is missing; when the permission is `denied` (for example in Claude's built-in browser pane), the line `foot.notifyBlocked` instead. On: the button reads `foot.notifyOff`; the choice is remembered (`prefs.notify`). The label carries the state; there is no `aria-pressed`.
- `arrivals(prev, board)` (pure) returns cards newly in Needs you or Stuck? since the previous successful board (never on the first board, never for Unread: the app already announces finished sessions). One arrival: `notify.needs_you` (body = the question or `ask.*`) or `notify.trouble` (body = `reasonLine`). Three or more at once: one `notify.many`. `tag` = session ID, no sound, no `requireInteraction`. A click focuses the window and calls `jumpTo(id)`.
- While notifications are on and the tab is hidden, poll every `HIDDEN_POLL_MS` (60 s); otherwise polling stops while hidden (§16).

**Favicon** (`favicon.mjs`): `faviconKind(counts)` → `needs` (Needs you > 0), `stuck` (Needs you 0, Stuck? > 0), `none`. `faviconHref(kind)` builds a 16×16 SVG data URI of the wordmark cabinet: a `#f0f8f7` tile (rx 2.5), six cells stroked `#101b24`; `needs` fills the top-left cell `#2e54ae`; `stuck` fills the middle-left cell `#101b24`; no numbers. The link's `href` changes only when the kind changes. Same icon in both themes. (`img-src 'self' data:` already allows it.)

**Tab title** (`tabTitle(t, counts, offline)`): Needs you > 0 → `app.tabTitle` with `{n}` = Needs you and `{pile}` = `bucket.needs_you.title`; else Stuck? > 0 → the same with Stuck?; else `app.name`. Offline → wrapped in `app.tabOffline`. Examples: `(4) Needs you — Pigeonholes`, `(4) 返事待ち — Pigeonholes`, `Pigeonholes`.

## 14. Keyboard

One `keydown` listener on `document` (`keys.mjs`). `keyAction(ev, ctx)` is pure and returns an action name or null.

| key | action |
|---|---|
| `j` / `↓`, `k` / `↑` | (the arrows also with single-key shortcuts off) move the cursor to the next / previous visible row in reading (DOM) order across piles, and focus its title button (`preventScroll`, then scroll into view inside the scroll padding) |
| `Enter`, `o` | open the cursor row's session: `openSession(id)` clicks a temporary `<a href="claude://…">` (the same as the row's Open link; To archive rows too). No cursor → the lede's session. Disabled IDs do nothing. On a focused row title, Enter opens instead of toggling (`preventDefault`); on any other focused control Enter keeps its native meaning |
| `Space` | toggle the cursor row's detail (on a focused title, native) |
| `x` | pick / unpick the cursor row when it is a To archive row (announce `live.picked` / `live.unpicked`); otherwise nothing |
| `a` | pick every suggested row (adds only); announce `live.selectAll`. Does nothing under `formatSuspect` |
| `c` | copy the next chunk (§12); with nothing picked, announce `live.nothingPicked`. After a fallback copy (textarea or dialog), focus returns to the focused control or the cursor row's title |
| `/` | focus the filter |
| `?` | open the help dialog |
| `1`–`6` | jump to Needs you, Stuck?, Unread, Working, Recent, To archive: open it if collapsed, cursor and focus on its first row; an empty pile announces `bucket.none` |
| `h` | the hand-off guide for the cursor row (§9.1): open its detail, bring the guide into view, focus its main button (Enter presses it); when there is no guide, announce `live.handoffNo` with the reason |
| `v` | switch to the canvas (§10.1) |
| `z` | switch to the canvas and fit all (the canvas far zoom replaces the v0.1 Overview) |
| `Esc` | in order, the first that applies: close the open dialog (native) → in the filter: clear it, or blur when already empty → collapse the cursor row's open detail → clear the family filter → clear the text filter. **Never** clears a selection or a batch |

- **IME-safe and polite**: ignore when `ev.isComposing` or `ev.keyCode === 229`; ignore when Ctrl, Meta or Alt is held; Shift is ignored only on named keys (Enter, Space, arrows): single-character keys match `ev.key`, the character the layout produced, so `/` and `1`–`6` work on layouts that need Shift for them (German, French) and Shift+J is simply not a key; ignore when the target is a text-entry control (`input` other than checkbox and radio, `textarea`, `select`, `[contenteditable]`) or inside an open `dialog` (Esc in the filter is the exception above); a focused checkbox counts as a control (Space and Enter stay native, the other keys work, and focusing a To archive row's checkbox puts the cursor on that row); ignore repeats for `x`, `a`, `c`, `h`, `v`, `z`.
- **WCAG 2.1.4 off switch**: the help dialog has a checkbox `help.off` (+ `help.offNote`), remembered in `prefs.keys` (default on). Off: every single-character shortcut (j k o x a c h v z / ? 1–6, and on the canvas also f + = − 0) is ignored in both views; Enter, Space, Esc, arrows and Tab keep working; the footer key hints hide, and so do the single-character hints inside controls (`kbd.hk`: `/` in the filter, `v` on the view switch, `f` on Fit all, `c` on Copy instruction) via `:root.keys-off`.
- **Hints inside controls** are `aria-hidden` so they stay out of the accessible name; the control carries `aria-keyshortcuts` instead (the lede's Open: `Enter`; the view switch: `v` and Fit all: `f` while shortcuts are on; Clear filter: `Escape`).
- The canvas has its own key map (§10.8), from the same listener: `keyAction` hands every key to `canvasKeyAction` while the view is the canvas.
- Keys mirror Claude Code's agent view where they overlap (j/k, Enter, Space, x, /, ?).

## 15. Focus and re-rendering

- Rendering is keyed by session ID (`reconcile`). A node is rebuilt only when its signature changes: `sig = lang + '|' + JSON.stringify(card) + '|' + flags` (flags: next, cursor, new, picked, copied, open, hand-off copied state). Switching language changes every signature, so every node is rebuilt once.
- The cursor is `{id, pile, index}` (`state.cursor`); `index` is the position among the rows that pile shows. After each board, `cursorAfter(cursor, lists)` (pure): the same ID in the same pile → keep; the ID moved to another pile → keep the **same pile and index** (the next row) and announce once `live.moved`; the pile emptied → the first row of the next non-empty pile; nothing left → no cursor. `setBoard` uses the whole board for `live.moved`; after the board is drawn, `render()` settles the cursor again with the **visible** rows (`listsFromRows(visibleRows())`), so it never lands on a row the filter, a preview cut or a closed group hides.
- A poll never moves DOM focus, except when the focused element was removed or hidden (inside `[hidden]` or `[inert]`, as when the selection bar hides after Clear selection or Close): then focus goes to the same control rebuilt, else the title button of the row now at the cursor (`focus({preventScroll: true})`), else the head of the pile it was in (for the selection bar: the To archive toggle; a plain pile head gets `tabindex=-1`). A focused element that the reorder **moved** stays connected, but the browser drops its focus to `body`: it gets the focus back (`reconcile` also removes leaving elements first and uses `moveBefore` where it exists, so fewer nodes move). The filter input never loses focus or text to a re-render.
- Open details, expanded lists, open groups and sub-groups, picks, the copied set, the batch, the view, the canvas camera and seats, and the open canvas bar survive re-renders (kept by ID or key). `overflow-anchor` keeps the visible rows still when rows are added above.
- `contentLang(text)` (pure): `'ja'` when the text contains kana or kanji (`/[぀-ヿ㐀-鿿]/`), else `'en'`. Content nodes (titles, bodies, quotes, questions) get `lang` when it differs from the UI language, so quotes and line breaking follow the content.
- The live region `#live` (polite) speaks only on: a row moving pile (the cursor's row), select-all, `x` (`live.picked` / `live.unpicked`), a copy (`live.copied`, and `live.copiedId` / `live.copiedLink` for the detail's copy buttons), a pile jump to an empty pile, a batch finishing (`sel.done`), the filter's match count after typing pauses (§11), a change in the kind of failure (§7), a hand-off copy (`handoff.copied`), `h` without a guide (`live.handoffNo`), and on the canvas a sheet moved (`canvas.moved`) or a Rearrange (`canvas.arrangeDone`). Never on an ordinary poll.

## 16. Updates and time

- `GET /api/board` every `POLL_MS` (5 s) with `If-None-Match`; timeout `FETCH_TIMEOUT_MS` (4 s), the first fetch `FIRST_FETCH_TIMEOUT_MS` (20 s). While `document.hidden`, stop (or `HIDDEN_POLL_MS` when notifications are on); fetch once on return.
- 304 → only the dateline is rewritten (`renderPulse()`); a full `render()` happens only to clear a failure notice. 200 → `setBoard`, `pruneSelection`, `cursorAfter`, `render()` (which settles the cursor on visible rows), `arrivals`; the ETag is taken only after the board is drawn. Only the fetch is in the fetch's `try`: an exception while drawing is the draw-failed state (§5), not offline.
- `serverNow − Date.now()` is kept as a clock offset; every time text uses server time.
- A **minute tick** (aligned to the next minute) calls `renderTimes()`: row time cells, lede times, the dateline, the quiet hints, the `asOfText`, `ctx.compacted` and `ctx.copied` phrases (on the canvas the slips' time cells are the same `time` elements; their titles' names hold no time). When a `badge.new` mark has expired, `pruneNew()` drops it and `render()` runs first (rows whose signature changed are rebuilt), and the time cells and hints are still rewritten afterwards. Nothing updates every second; the only seconds shown are in the stale dateline, updated on the 5 s poll.
- Times: `durationText(t, ms, 'short'|'long')` floors to minutes (< 1 h), hours (< 24 h), days; under 1 minute it returns `''` and callers use the `_now` form. Row cells use short units, sentences use long units. `timeText(t, kind, since, now)` returns `time.<kind>` with `{dur}` and `{ago}` (= `time.agoPhrase`); each language picks one.

## 17. Language

- `detectLang({search, saved, languages})` (pure): `?lang=en|ja` (not saved) > `prefs.lang` > the first entry of `navigator.languages` whose primary subtag is `en` or `ja` > `en`.
- The header text button shows the other language in its own words (`lang.switchTo`: 「English」 in the Japanese UI, 「日本語」 in the English UI) in a `span` with `lang` set to that language, followed by a visually hidden ` (lang.toggleAria)` in the UI language. No `aria-label`: the accessible name starts with the visible word (WCAG 2.5.3), and only the visible word is marked as the other language. A click sets `prefs.lang`, saves, removes `lang` from the URL with `history.replaceState`, and calls `setLanguage(lang)`: `state.t = makeT(lang)`, `document.documentElement.lang = lang`, `applyStaticText()`, `render()`.
- The board JSON is the same for every language; switching never refetches. Demo content follows the terminal language (board.md §11), not the toggle.
- The copied archive instruction follows the UI language.
- `?theme=light|dark` (for screenshots) sets `document.documentElement.dataset.theme`; it is not saved and there is no theme button.
- `makeT(lang)`: `entry = dict[key] ?? DICT.en[key] ?? key`; `fill(pickForm(lang, entry, params.n), params)`. English plurals are `{one, other}`; Japanese entries are plain strings. Templates that hold DOM nodes (`<code>` in `lede.offlineNote`, `kbd`) go through `fillParts` → `partsToNodes`.

## 18. First run, help, footer

**First run**: when `prefs.seenIntro` is not set and storage works, `#intro` shows the legend once, at the top of the archive page: beside the live piles from 60rem, after Working below 60rem, so it never pushes the first row below the fold. Head `intro.title` + [`intro.ok`] text button, then six lines (pile name in the display face + `intro.<key>`), then `intro.trust`. [`intro.ok`] sets `prefs.seenIntro`. If storage fails, the legend is not shown (it is always in the help dialog). It is not shown on the empty board (the pages are hidden there); it appears once there are sessions.

**Help dialog** (`<dialog id="help">`, `showModal()`, `::backdrop` `--color-scrim`, radius `--radius-dialog`): title `help.title`, the key table (`help.k.*`, each with `kbd`), the legend (`intro.*`), the canvas mark key (`help.marks`: the four slip piles' shapes of design.md §12), the off switch (`help.off`), [`help.close`]. It opens at the top: focus goes to the title (`tabindex=-1`, `preventScroll`) and the dialog's scroll is reset; Tab reaches the off switch and Close. Esc and the close button return focus to the "?" button.

**Footer** (`--rule-ink` above; two columns from 60rem):
- left: `foot.trust` (bold ink) · key hints `kbd` + `foot.keys.*`, nowrap each (hidden when shortcuts are off) · the notify button + `foot.notifyNote` (or `foot.notifyBlocked`, §13).
- right: `foot.archived` (when > 0) · `foot.demo` (when `stats.demo`) · `foot.noDir` (when `stats.transcriptsDirMissing`) and `foot.badFormat` (when `unknownTurnRecent / recentWithTranscript > 0.5`), `foot.ctxFormat` (when `stats.contextSuspect`) and `foot.actFormat` (when `stats.activitySeen === 0` and `stats.recentWithTranscript ≥ FORMAT_SUSPECT_MIN`), all visible in ink · `details` `foot.diag` holding `foot.bad` (stats.bad > 0), `foot.missing` + `foot.missingWhy` (transcriptsMissingRecent > 0), else `foot.allGood` · `foot.disclaimer` (muted).
- The footer's signature holds only what it shows (not `scanMs`, `contextSeen` or other stats), and a rebuild keeps `foot.diag` open when it was open. The footer is the list's: the canvas view hides it.

## 19. Copy deck

Rules: placeholders are `{name}`; the plural count is always `{n}`; an English cell written `a \| b` means `{one: a, other: b}`; `␣` marks a meaningful space. `{days}` comes from `RECENT_MS`, `{days}` in idle_30d from `IDLE_SAFE_MS`, `{min}`/`{limit}` from `QUIET_MS`. A key keeps its name while its meaning is unchanged. Removed in v0.2 with the Overview: `ledger.overviewOpen`, `ledger.overviewClose`, every `overview.*`, `help.k.overview`, `foot.keys.overview`. This table is the source of truth for both languages, and the tests are baselined against it. Both dictionaries must have the same keys and the same placeholders per key (parity test).

### 19.1 App, masthead, dates

| key | en | ja |
|---|---|---|
| `app.name` | Pigeonholes | Pigeonholes |
| `app.tabTitle` | ({n}) {pile} — {name} | ({n}) {pile} — {name} |
| `app.tabOffline` | {title} (offline) | {title} (オフライン) |
| `mast.home` | Pigeonholes, back to top | Pigeonholes 先頭へ |
| `mast.trust` | Session files stay read-only. Worktrees need confirmation. | セッションは読み取り専用。worktreeは確認後に作成。 |
| `mast.demo` | Demo data | デモデータ |
| `mast.help` | Keyboard keys | キー一覧 |
| `date.asOf` | {wd} {d} {mon}, as of {hm} | {mon} {d} 日 ({wd}) {hm} 時点 |
| `date.stale` | data from {ago} | {ago}の内容 |
| `date.today` | today {hm} | 今日 {hm} |
| `date.wd.0` … `date.wd.6` | Sun, Mon, Tue, Wed, Thu, Fri, Sat | 日, 月, 火, 水, 木, 金, 土 |
| `date.mon.0` … `date.mon.11` | Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec | 1 月, 2 月, 3 月, 4 月, 5 月, 6 月, 7 月, 8 月, 9 月, 10 月, 11 月, 12 月 |
| `filter.label` | Filter by title, project, summary or what it is doing | タイトル・プロジェクト・要約・していることで絞り込み |
| `filter.placeholder` | Filter | 絞り込み |
| `lang.switchTo` | 日本語 | English |
| `lang.toggleAria` | Switch language | 言語を切り替える |

### 19.2 Lede

| key | en | ja |
|---|---|---|
| `lede.aria` | What to do next | 次にやること |
| `lede.answer` | Answer “{title}” first | まず『{title}』に答える |
| `lede.check` | Check on “{title}” first | まず『{title}』の様子を見る |
| `lede.read` | Read “{title}” first | まず『{title}』の結果を読む |
| `lede.waiting` | Waiting for {dur} | {dur}待っています |
| `lede.waiting_now` | Waiting since just now | たった今から待っています |
| `lede.stalled` | Quiet for {dur} | {dur}、動きがありません |
| `lede.stopped` | Stopped {ago} | {ago}に止まりました |
| `lede.stopped_now` | Stopped just now | たった今止まりました |
| `lede.ended` | Finished {ago} | {ago}に終わりました |
| `lede.ended_now` | Finished just now | たった今終わりました |
| `lede.more.needs_you` | {n} more is waiting for you, longest first. \| {n} more are waiting for you, longest first. | 返事待ちはほかに {n} 件。長く待っている順に並んでいます。 |
| `lede.more.trouble` | {n} more may be stuck. | 「止まったかも」はほかに {n} 件。 |
| `lede.more.unread` | {n} more is finished and not read yet. \| {n} more are finished and not read yet. | 未読はほかに {n} 件。 |
| `lede.calm` | Nothing needs you. | あなたの番はありません |
| `lede.calmSince` | None since {time}. | {time} から 0 件。 |
| `lede.calmWorking` | {n} session is working; just wait. \| {n} sessions are working; just wait. | 作業中の {n} 件は待つだけです。 |
| `lede.calmIdle` | Nothing is running either. | 動いているものもありません。 |
| `lede.calmCleanup` | When you have a minute: {n} session can be archived ({r} suggested). \| When you have a minute: {n} sessions can be archived ({r} suggested). | 手が空いたら、片付けられるものが {n} 件あります (おすすめ {r} 件)。 |
| `lede.calmCleanupBtn` | Review them | 片付けを見る |
| `lede.loading` | Reading your sessions… | セッションを読み込んでいます… |
| `lede.loadingNote` | The first scan reads every session, so it takes a few seconds. | 最初の 1 回は全部を読むので、数秒かかります。 |
| `lede.empty` | No sessions yet. | セッションはまだありません |
| `lede.emptyNote` | Start a chat in the Code tab of the Claude desktop app and it will appear here. | Claude デスクトップアプリの Code タブで会話を始めると、ここに並びます。 |
| `lede.offline` | Can't reach the board's server. | サーバーにつながりません |
| `lede.offlineNote` | Start the board again in a terminal: {cmd} (from a clone: npm start). This page connects by itself. | ターミナルでボードをもう一度起動してください: {cmd} (clone から使うなら npm start)。つながれば自動で表示します。 |
| `lede.serverError` | The board couldn't be built. | 一覧を作れませんでした |
| `lede.serverErrorNote` | The reason is in the terminal where you started it. | サーバーを起動したターミナルに理由が出ています。 |
| `open.text` | Open | 開く |
| `ask.plan` | Review the plan and say whether to go ahead. | プランを確認して、進めてよいか答えてください |
| `ask.question` | Answer the question. | 質問に答えてください |

### 19.3 Counts ledger and piles

| key | en | ja |
|---|---|---|
| `ledger.aria` | Sections | 欄の一覧 |
| `ledger.total` | Total ({a} archived not shown) | 計 (アーカイブ済み {a} 件は除く) |
| `ledger.totalNoArchived` | Total | 計 |
| `ledger.match` | {m} of {n} match | 一致 {m} / {n} 件 |
| `view.canvas` | Canvas | キャンバスで見る |
| `view.list` | List | 一覧で見る |
| `bucket.needs_you.title` | Needs you | 返事待ち |
| `bucket.needs_you.verb` | Open and answer. Longest wait first. | 開いて答える。長く待っている順 |
| `bucket.trouble.title` | Stuck? | 止まったかも |
| `bucket.trouble.verb` | Open and check. Restart it if nothing moves. | 開いて様子を見る。動かなければやり直す |
| `bucket.unread.title` | Unread | 未読 |
| `bucket.unread.verb` | Finished. Open and read. | 終わっています。開いて読む |
| `bucket.working.title` | Working | 作業中 |
| `bucket.working.verb` | Just wait. | 待つだけ |
| `bucket.recent.title` | Recent | 最近 |
| `bucket.recent.verb` | Read in the last {days} days. Nothing to do. | {days} 日以内に読み終えたもの。やることなし |
| `bucket.cleanup.title` | To archive | 片付け |
| `bucket.cleanup.verb` | Pick, copy, paste into Claude. | 選んでコピーし、Claude に貼る |
| `bucket.match` | {n} match \| {n} matches | 一致 {n} 件 |
| `bucket.none` | Nothing in {pile} right now | 「{pile}」は 0 件です |
| `recent.empty` | Nothing read in the last {days} days. | {days} 日以内に読み終えたものはありません |
| `list.more` | Show {n} more | 残り {n} 件を表示 |
| `list.less` | Show only the first {n} | 最初の {n} 件だけ表示 |
| `page.more` | {n} more | さらに {n} 件 |

### 19.4 Rows, projects, families, routines, PRs

| key | en | ja |
|---|---|---|
| `untitled` | (untitled) | (無題) |
| `open.row` | Open ↗ | 開く ↗ |
| `open.aria` | Open: {title} | 開く: {title} |
| `open.title` | Open this session in the Claude app | Claude アプリでこのセッションを開く |
| `open.disabled` | This session can't be opened from here | このセッションはここからは開けません |
| `open.demoTitle` | Demo data: this session does not exist in the Claude app | デモデータです。このセッションは Claude アプリにはありません |
| `badge.new` | New | 新着 |
| `row.copied` | Copied | コピー済み |
| `row.selectAria` | Select: {title} | 選ぶ: {title} |
| `row.quietHint` | Quiet {dur}. Moves to “{pile}” at {limit}. | {dur}動きなし。{limit}たつと「{pile}」に移ります |
| `row.keysHint` | Enter opens it in the Claude app. Space shows details. | Enter で Claude アプリで開きます。Space で詳しく見られます。 |
| `project.other` | No project folder | フォルダなし |
| `project.otherGloss` | Chats opened outside a project folder | プロジェクトのフォルダの外で開いた会話 |
| `project.extra` | +{n} | +{n} |
| `family.parent` | ↳ Parent: {name} | ↳ 親: {name} |
| `family.parentMissing` | (not found) | (見つからない) |
| `family.children` | {n} child session \| {n} child sessions | 子 {n} 件 |
| `family.childrenWith` | {n} child session ({list}) \| {n} child sessions ({list}) | 子 {n} 件 ({list}) |
| `family.part.needs_you` | {n} needs you \| {n} need you | 返事待ち {n} |
| `family.part.trouble` | {n} maybe stuck | 止まったかも {n} |
| `family.part.unread` | {n} unread | 未読 {n} |
| `family.part.working` | {n} working | 作業中 {n} |
| `family.filterTitle` | Show only this session and its related sessions | この親子だけ表示する |
| `routine.runs` | Scheduled task ({n} run) \| Scheduled task ({n} runs) | 定期実行 (全 {n} 回) |
| `routine.flaky` | {s} of the last {n} runs stopped midway | 過去 {n} 回のうち {s} 回は途中で止まりました |
| `routine.history` | Last run: {done} finished, {stalled} stopped midway \| Last {n} runs: {done} finished, {stalled} stopped midway | 過去 {n} 回: 完了 {done}、途中で止まった {stalled} |
| `pr.labelState` | PR #{num} {state} | PR #{num} {state} |
| `pr.labelRepo` | {repo} #{num} {state} | {repo} #{num} {state} |
| `pr.state.OPEN` | open | マージ前 |
| `pr.state.MERGED` | merged | マージ済み |
| `pr.state.CLOSED` | closed | クローズ済み |
| `pr.detail` | #{num} {repo} ({state}) | #{num} {repo} ({state}) |
| `pr.more` | +{n} more | 他 {n} 件 |

### 19.5 Time

| key | en | ja |
|---|---|---|
| `time.unit.second` | {n} second \| {n} seconds | {n} 秒 |
| `time.unit.minute` | {n} minute \| {n} minutes | {n} 分 |
| `time.unit.hour` | {n} hour \| {n} hours | {n} 時間 |
| `time.unit.day` | {n} day \| {n} days | {n} 日 |
| `time.short.second` | {n} s | {n} 秒 |
| `time.short.minute` | {n} min | {n} 分 |
| `time.short.hour` | {n} h | {n} 時間 |
| `time.short.day` | {n} day \| {n} days | {n} 日 |
| `time.agoPhrase` | {dur} ago | {dur}前 |
| `time.waiting` | waiting {dur} | {dur}待ち |
| `time.waiting_now` | waiting <1 min | たった今から待ち |
| `time.stopped` | stopped {ago} | {ago}に停止 |
| `time.stopped_now` | stopped just now | たった今停止 |
| `time.stalled` | quiet {dur} | {dur}動きなし |
| `time.stalled_now` | quiet <1 min | たった今から動きなし |
| `time.ended` | done {ago} | {ago}に終了 |
| `time.ended_now` | done just now | たった今終了 |
| `time.updated` | updated {ago} | {ago}に更新 |
| `time.updated_now` | updated just now | たった今更新 |
| `time.running` | {dur} running | {dur}経過 |
| `time.running_now` | just started | たった今開始 |
| `time.latest` | latest run {ago} | 最新回 {ago} |
| `time.latest_now` | latest run just now | 最新回 たった今 |
| `time.moved` | last active {ago} | 最後に動いたのは {ago} |
| `time.moved_now` | last active just now | 最後に動いたのはたった今 |
| `time.ago` | active {ago} | {ago}に更新 |
| `time.ago_now` | active just now | たった今更新 |

Unknown kinds fall back to `time.ago`.

### 19.6 Reasons (`reasonLine`)

| key | en | ja |
|---|---|---|
| `reason.stalled_prompt` | No reply to your last message yet. | 送った指示に返事がありません |
| `reason.stalled_tool` | Stopped during a tool. It may be waiting for permission. | ツールの途中で止まっています。許可の確認待ちかもしれません |
| `reason.git_startup` | Failed to start (Git isn't working). | 起動に失敗しました (Git が使えない状態) |
| `reason.not_started` | It never started. | 起動しないまま止まっています |
| `reason.limit` | Hit the usage limit. | 使用上限で止まりました |
| `reason.limit_resetAt` | Hit the usage limit. The limit resets at {time}. | 使用上限で止まりました。上限は {time} に戻ります |
| `reason.limit_reset` | Hit the usage limit. The app says “{reset}”. | 使用上限で止まりました。アプリの表示は「{reset}」 |
| `reason.error` | Stopped by an error: “{error}” | エラーで止まりました: 「{error}」 |
| `reason.background` | Working in the background | バックグラウンドで作業中 |
| `reason.starting` | Starting | 起動中 |
| `reason.retried` | Started again later with the same task. | あとで同じ内容で起動し直しています |
| `reason.routine_all` | {n} run \| All {n} runs | 全 {n} 回 |
| `reason.routine_some` | {n} older run (of {total}) \| {n} older runs (of {total}) | 古い回 {n} 件 (全 {total} 回) |
| `reason.routine_elsewhere` | The latest run is under “{bucket}”. | 最新回は「{bucket}」にあります |
| `reason.pr_done_more` | {list} +{n} more | {list} ほか {n} 件 |
| `reason.old_error` | Error: “{error}” | エラー: 「{error}」 |
| `reason.old_question` | Question: “{question}” | 質問: 「{question}」 |
| `sep.list` | ,␣ | 、 |
| `sep.sentence` | .␣ | 。 |

`reasonLine(t, card)`: stalled → `reason.stalled_<via>`; git_startup, not_started, retried → `reason.<reason>`; limit → `reason.limit_resetAt` when `parseResetTime(reset)` understands it (`/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i` → 24-hour `HH:mm`), else `reason.limit_reset` when `reset` is present, else `reason.limit`; error → `reason.error`; routine_old → `reason.routine_all` when `older === total`, else `reason.routine_some`, then `sep.sentence` + `reason.routine_elsewhere` when `latestBucket` is present (`{bucket}` = that pile's title); pr_done → each of `prs` through `prLabel`, joined by `sep.list`, wrapped in `reason.pr_done_more` when `more > 0`; old_error, old_question → their keys (nothing when the param is missing); every other reason → `''`. In Working rows, `background` and `starting` render in the meta line, not the body.

### 19.7 Detail panel

| key | en | ja |
|---|---|---|
| `detail.state` | Now | いまの状態 |
| `detail.stateValue` | {pile} ({time}) | {pile} ({time}) |
| `detail.activity` | Doing | していること |
| `detail.step` | Step | 手順 |
| `detail.context` | Context | コンテキスト |
| `detail.contextValue` | {pct}% ({used} of {window} tokens). It summarizes itself at about {at}. | {pct}% ({window} トークン中 {used})。約 {at} で自動で要約されます。 |
| `detail.contextEst` | The size limit is a guess. | 上限の大きさは推定です。 |
| `detail.summary` | Claude's summary | Claude の要約 |
| `detail.error` | Full error | エラー全文 |
| `detail.branch` | Branch | ブランチ |
| `detail.worktree` | Worktree | 作業ツリー |
| `detail.created` | Created | 作成 |
| `detail.turns` | Turns | やりとり |
| `detail.turnsValue` | {n} | {n} 回 |
| `detail.routine` | Scheduled task | 定期実行 |
| `detail.pr` | PRs | PR |
| `detail.related` | Related | 親子 |
| `detail.relatedAria` | Sessions related to “{title}” | 『{title}』の親子 |
| `detail.self` | ← this one | ← これ |
| `detail.treeMore` | +{n} more | ほか {n} 件 |
| `detail.familyOnly` | Show only these | この親子だけ表示 |
| `detail.copyId` | Copy ID | ID をコピー |
| `detail.copyLink` | Copy link | リンクをコピー |
| `detail.copied` | Copied ✓ | コピーした ✓ |

### 19.8 Board notices, filter

| key | en | ja |
|---|---|---|
| `banner.offline.lead` | Can't reach the board's server. | サーバーにつながりません。 |
| `banner.offline.text` | Showing data from {ago}. Run the same command again in the terminal where you started it. Open still works. | 表示は {ago}の内容です。ボードを起動したターミナルで、同じコマンドをもう一度実行してください。「開く」は今も使えます。 |
| `banner.server.lead` | The board couldn't be built. | 一覧を作れませんでした。 |
| `banner.server.text` | The reason is in the terminal where you started it. Showing data from {ago}. | サーバーを起動したターミナルに理由が出ています。表示は {ago}の内容です。 |
| `banner.version.lead` | The board was updated. | ボードが新しくなりました。 |
| `banner.version.text` | Reload this page. | このページを再読み込みしてください。 |
| `banner.version.btn` | Reload | 再読み込み |
| `banner.render.lead` | The page couldn't draw the latest data. | 新しいデータを表示できませんでした。 |
| `banner.render.text` | Reload this page. If it happens again, the details are in the browser console. | このページを再読み込みしてください。繰り返すときは、ブラウザのコンソールに詳細が出ています。 |
| `banner.format.lead` | The Claude app's file format may have changed. | Claude アプリのファイル形式が変わったかもしれません。 |
| `banner.format.no_timestamps` | Many sessions have no readable dates, so “Select all suggested” is off. You can still pick sessions one by one. | 日時が読めないセッションが多くあります。安全のため「おすすめをまとめて選ぶ」を止めています。1 件ずつは選べます。 |
| `banner.format.no_session_files` | Session folders were found, but there are no session files in them. | セッションのフォルダは見つかりましたが、中にセッションのファイルがありません。 |
| `banner.filter` | Filtering by “{q}”: {n} match \| Filtering by “{q}”: {n} matches | 『{q}』で絞り込み中: 一致 {n} 件 |
| `banner.family` | Showing only “{title}” and its related sessions | 『{title}』の親子だけ表示中 |
| `banner.clear` | Clear | 解除 |
| `nomatch.query.lead` | Nothing matches “{q}”. | 『{q}』に一致するセッションはありません。 |
| `nomatch.query.text` | Searched titles, projects, summaries and what sessions are doing. | タイトル・プロジェクト・要約・していることを探しました。 |
| `nomatch.family` | Nothing in this family matches. | この親子には該当するものがありません。 |
| `nomatch.clear` | Clear filter | 絞り込みを消す |

### 19.9 Canvas

| key | en | ja |
|---|---|---|
| `canvas.aria` | Canvas: sessions by project | キャンバス: プロジェクトごとのセッション |
| `canvas.keys` | Arrows pan, + and − zoom, f fits everything. | 矢印で移動、+ と − で拡大縮小、f で全体 |
| `canvas.keysOff` | Arrows pan. The buttons in the bar below zoom and fit everything. | 矢印で移動。拡大縮小と全体の表示は下の帯のボタンで |
| `canvas.headAria` | {project}: {list} | {project}: {list} |
| `canvas.headKeys` | Enter shows buttons that move this sheet. Shift and the arrow keys move it too. | Enter で用紙を動かすボタンを表示。Shift と矢印でも動かせます |
| `canvas.part` | {pile} {n} | {pile} {n} |
| `canvas.farCount` | {n} for you | 要対応 {n} |
| `canvas.slip` | {pile}: {title}, {time} | {pile}: {title}、{time} |
| `canvas.slipName` | {pile}: {title} | {pile}: {title} |
| `canvas.slipKeys` | Enter opens it in the Claude app. Space shows details. The arrow keys move to the session next to it. | Enter で Claude アプリで開く。Space で詳しく。矢印で隣のセッションへ |
| `canvas.noMatch` | not in the filter | 絞り込み外 |
| `canvas.fold` | Only to archive | 片付けだけ |
| `canvas.foldCount` | {n} project \| {n} projects | {n} 件のプロジェクト |
| `canvas.foldOpen` | opens To archive in the list | 一覧の片付けを開く |
| `canvas.faded` | To archive; a related session is still open | 片付け (親子の誰かがまだ使用中) (kept for a faded slip; v0.2 draws none) |
| `canvas.zoomIn` | Zoom in | 拡大 |
| `canvas.zoomOut` | Zoom out | 縮小 |
| `canvas.zoom` | {n}% | {n}% |
| `canvas.fit` | Fit all | 全体を表示 |
| `canvas.arrange` | Rearrange | 並べ直す |
| `canvas.arrangeDone` | Rearranged {n} project. \| Rearranged {n} projects. | {n} 件のプロジェクトを並べ直しました。 |
| `canvas.moved` | Moved {project}. | {project} を動かしました。 |
| `canvas.blocked` | There is no room to move {project} that way. | {project} はその向きにはもう動かせません。 |
| `canvas.hint` | Drag to pan. Drag or press a project name to move its sheet. Ctrl + wheel to zoom. | ドラッグで移動。プロジェクト名をドラッグか押すと用紙を動かせます。Ctrl+ホイールで拡大縮小 |
| `canvas.close` | Close | 閉じる |
| `canvas.barAria` | Canvas tools | キャンバスの操作 |
| `canvas.sheetLead` | Move “{project}” | 『{project}』を動かす |
| `canvas.sheetHint` | Each press moves it a little. On its name, Shift and the arrow keys do the same. | 押すたびに少しずつ動きます。プロジェクト名の上では Shift と矢印でも同じです |
| `canvas.move.left` / `.up` / `.down` / `.right` | Move left / Move up / Move down / Move right | 左へ / 上へ / 下へ / 右へ |
| `canvas.sheetFit` | Show this sheet | この用紙を表示 |

### 19.10 To archive

| key | en | ja |
|---|---|---|
| `cleanup.ba` | {all} sessions now. Archiving every suggestion leaves {left}. | いま {all} 件。おすすめを全部片付けると {left} 件になります。 |
| `cleanup.steps.aria` | Steps | 手順 |
| `cleanup.step1` | Pick | 選ぶ |
| `cleanup.step2` | Copy the instruction | 指示文をコピー |
| `cleanup.step3` | Paste it into Claude | Claude に貼って送る |
| `cleanup.stepNow` | ␣(now) | ␣(いまここ) |
| `cleanup.stepDone` | ␣(done) | ␣(済み) |
| `cleanup.why` | Archiving deletes nothing; the Claude app can restore it. | アーカイブは消去ではありません。Claude アプリで戻せます。 |
| `cleanup.selectAll` | Select all {n} suggested | おすすめ {n} 件をまとめて選ぶ |
| `cleanup.tally` | {sel} / {n} | {sel} / {n} |
| `cleanup.def` | Left out: open PRs, pinned, marked to keep, unread reports, children in use. | 外したもの: 開いた PR・ピン留め・残す印・未読の報告・使用中の子 |
| `cleanup.retried` | Failed starts you already retried | もう一度起動し直したもの |
| `cleanup.routine_old` | Older runs of the same scheduled task | 同じ定期実行の古い回 |
| `cleanup.pr_done` | PRs merged or closed | PR が閉じたもの |
| `cleanup.old_error` | Error for {days}+ days | {days} 日以上エラーのまま |
| `cleanup.old_question` | Unanswered question, {days}+ days old | {days} 日以上前の質問に返事していない |
| `cleanup.idle_30d` | Untouched for {days}+ days | {days} 日以上さわっていない |
| `cleanup.idle_7d` | Untouched for {from}–{to} days | {from}〜{to} 日さわっていない |
| `cleanup.notSuggested` | Left out of suggestions, to be safe. You can still pick them one by one. | 念のため、おすすめから外しています。1 件ずつなら選べます。 |
| `cleanup.groupAria` | Select the suggested in “{group}” | 『{group}』のおすすめを選ぶ |
| `cleanup.subAria` | Select the {n} suggested in {project} | {project} のおすすめ {n} 件を選ぶ |
| `cleanup.routineTick` | One tick selects {n} | チェック 1 つで {n} 件 |
| `cleanup.routineAria` | Select: {n} older runs of “{title}” | 選ぶ: 『{title}』の古い回 {n} 件 |
| `cleanup.empty` | Nothing to archive | 片付けるものはありません |
| `note.open_pr` | PR still open | PR がまだ開いています |
| `note.exempt` | Marked to keep | 残す印が付いています |
| `note.starred` | Pinned | ピン留めしています |
| `note.unread` | Last report not read | 最後の報告をまだ読んでいません |
| `note.child` | A child session is still in use | 子の会話がまだ使われています |

### 19.11 Selection bar, copy

| key | en | ja |
|---|---|---|
| `sel.aria` | Selected sessions | 選択中のセッション |
| `sel.count` | {n} selected | {n} 件を選択中 |
| `sel.hidden` | {h} of them inside closed groups. | うち {h} 件は閉じたグループの中。 |
| `sel.filtered` | {h} of them hidden by the filter. | うち {h} 件は絞り込みで隠れています。 |
| `sel.sum` | {all} sessions → {left} after archiving | 全 {all} 件 → 片付け後 {left} 件 |
| `sel.how` | Paste the copied instruction into any Claude chat and Claude archives them. | コピーした指示文を Claude のどれかの会話に貼ると、Claude がアーカイブします。 |
| `sel.copy` | Copy instruction | 指示文をコピー |
| `sel.copyRange` | Copy instruction ({from}–{to} of {n}) | 指示文をコピー ({from}〜{to} / {n} 件) |
| `sel.copyNext` | Copy the next {k} ({from}–{to}) | 次の {k} 件をコピー ({from}〜{to}) |
| `sel.copyAgain` | Copy again | もう一度コピー |
| `sel.copiedBtn` | Copied ✓ | コピーした ✓ |
| `sel.clear` | Clear selection | 選択を解除 |
| `sel.paste` | ③ Paste it into any Claude chat and send | ③ Claude のどれかの会話に貼って送ってください |
| `sel.progress` | {done} of {total} archived | {total} 件のうち {done} 件が片付きました |
| `sel.checking` | Checking the other {left} every {s} seconds. | 残りの {left} 件は {s} 秒ごとに確かめています。 |
| `sel.checkingZero` | Checking every {s} seconds. | {s} 秒ごとに数え直します。 |
| `sel.now` | {all} sessions → {now} now. | 全 {all} 件 → いま {now} 件。 |
| `sel.permission` | If Claude asks for permission, allow it in that chat. | 承認を求められたら、その会話で許可してください。 |
| `sel.cantArchive` | If Claude says it can't archive, archive them from the app's sidebar; this board counts again by itself. | Claude が片付けられないと言ったら、アプリの横の一覧からアーカイブしてください。このボードが自動で数え直します。 |
| `sel.copiedText` | Copied text | コピーした指示文 |
| `sel.moreLines` | … and {n} more line \| … and {n} more lines | … ほか {n} 行 |
| `sel.done` | {n} archived | {n} 件 片付きました |
| `sel.doneSum` | {all} → {now} sessions. {today} archived today. | 全 {all} 件 → {now} 件。今日は {today} 件片付けました。 |
| `sel.close` | Close | 閉じる |
| `sel.left` | {done} archived. {left} still here. | {done} 件 片付きました。{left} 件が残っています |
| `sel.leftWhy` | Claude may have skipped them: it was asked to skip sessions that are working, pinned, or the chat you pasted into. | Claude が飛ばしたのかもしれません。作業中のもの・ピン留め・貼った会話自身は飛ばすように頼んでいます。 |
| `sel.none` | Nothing archived yet. Check that you pasted it and sent it. | まだ 1 件も片付いていません。貼って送ったか確かめてください。 |
| `sel.reselect` | Reselect the {n} left | 残った {n} 件を選び直す |
| `sel.demo` | Demo data: these IDs are made up, so pasting this archives nothing. | デモデータです。ID は作り物なので、貼っても何も片付きません。 |
| `fallback.title` | Couldn't copy automatically. Press {key} to copy, then click “Copied it”. | 自動でコピーできませんでした。{key} でコピーしてから「コピーした」を押してください |
| `fallback.confirm` | Copied it | コピーした |
| `fallback.close` | Close (don't copy) | 閉じる (コピーしない) |
| `archive.line1` | Please archive the following session (archiving can be undone). \| Please archive the following {n} sessions (archiving can be undone). | 次の {n} 件のセッションをアーカイブしてください (アーカイブは後から元に戻せます)。 |
| `archive.line2` | Skip this session itself, any session that is still working, and pinned sessions. Do nothing except archive these IDs. | このセッション自身・作業中のもの・ピン留めしたものは飛ばしてください。ID 以外の操作はしないでください。 |
| `archive.line3` | When done, reply only with "archived N, skipped N". | 終わったら「アーカイブ ○ 件・飛ばした ○ 件」とだけ教えてください。 |

### 19.12 First run, help, footer, notifications, announcements

| key | en | ja |
|---|---|---|
| `intro.title` | How to read this board | このボードの読み方 |
| `intro.ok` | Got it | わかった |
| `intro.needs_you` | Claude is waiting for your answer. Open it and answer. | Claude があなたの答えを待っています。開いて答える。 |
| `intro.trouble` | An error, the usage limit, or no activity for {min} minutes. Open it and check. | エラー・使用上限・{min} 分以上動きなし。開いて様子を見る。 |
| `intro.unread` | Finished, and you haven't read the result yet. | 終わった結果をまだ読んでいません。 |
| `intro.working` | Running right now. Just wait. | いま動いています。待つだけ。 |
| `intro.recent` | Read within the last {days} days. | {days} 日以内に読み終えたもの。 |
| `intro.cleanup` | Old sessions. Pick some and ask Claude to archive them. | 古いもの。選んで Claude にアーカイブを頼めます。 |
| `intro.trust` | Select a title to see its details. | 件名を押すと詳しく見られます。 |
| `help.title` | Keys | キー一覧 |
| `help.close` | Close | 閉じる |
| `help.k.move` | Next or previous row | 次 / 前の行へ |
| `help.k.open` | Open the session in the Claude app | Claude アプリで開く |
| `help.k.peek` | Show or hide details | 詳しく (開く / 閉じる) |
| `help.k.pick` | Pick or unpick a row to archive | 片付けの行を選ぶ / 外す |
| `help.k.all` | Select all suggested | おすすめをまとめて選ぶ |
| `help.k.copy` | Copy the instruction (next 50) | 指示文をコピー (次の 50 件) |
| `help.k.filter` | Filter | 絞り込み |
| `help.k.jump` | Jump to a section (Needs you … To archive) | 欄へ移動 (返事待ち … 片付け) |
| `help.k.view` | Switch between the list and the canvas | 一覧とキャンバスを切り替える |
| `help.k.handoff` | Hand off the session (copy the instruction) | 引き継ぐ (指示文をコピー) |
| `help.k.canvas` | Canvas: + − zoom, 0 = 100%, f = fit all, z = fit all and back, arrows pan | キャンバス: + − で拡大縮小、0 で 100%、f で全体、z で全体と元の表示を往復、矢印で移動 |
| `help.k.help` | This list | このキー一覧 |
| `help.k.slipMove` | Canvas, on a session: the next session that way | キャンバスの付箋の上で: その向きの隣のセッションへ |
| `help.k.nudge` | Canvas, on a project name: move the sheet (Enter shows buttons for it) | キャンバスのプロジェクト名の上で: 用紙を動かす (Enter で動かすボタン) |
| `help.k.esc` | Close, in order: dialog, filter, details. On the canvas, then step out of a session or project name | 閉じる (キー一覧 → 絞り込み → 詳しく の順)。キャンバスでは次に付箋・プロジェクト名から離れる |
| `help.marks` | Canvas marks | キャンバスの印 |
| `help.off` | Turn off single-key shortcuts | 一文字キーを使わない |
| `help.offNote` | Enter, Space, Esc, the arrow keys and Tab keep working. | Enter・Space・Esc・矢印・Tab はそのまま使えます。 |
| `foot.trust` | Session files stay read-only. Worktrees need confirmation. | セッションは読み取り専用。worktreeは確認後に作成。 |
| `foot.keys.move` | move | 移動 |
| `foot.keys.open` | open | 開く |
| `foot.keys.peek` | details | 詳しく |
| `foot.keys.pick` | pick | 選ぶ |
| `foot.keys.filter` | filter | 絞り込み |
| `foot.keys.view` | canvas | キャンバス |
| `foot.keys.more` | more keys | ほかのキー |
| `foot.notifyOn` | Turn on notifications | 通知をオンにする |
| `foot.notifyOff` | Turn off notifications | 通知をオフにする |
| `foot.notifyNote` | Only for Needs you and Stuck?. The Claude app already tells you when a session finishes. | 「返事待ち」と「止まったかも」だけ。終わった知らせは Claude アプリが出します。 |
| `foot.notifyBlocked` | Notifications are blocked for this page in this browser. | このブラウザでは、このページの通知が止められています。 |
| `foot.archived` | {n} archived session not shown. \| {n} archived sessions not shown. | アーカイブ済みの {n} 件は表示していません。 |
| `foot.demo` | Showing demo data, not your sessions. | デモデータを表示しています。あなたのセッションではありません。 |
| `foot.noDir` | Transcript folder not found, so “Working” and “Stuck?” can't be detected. | 会話ログのフォルダが見つかりません。「作業中」「止まったかも」は判定できません。 |
| `foot.badFormat` | Can't read the transcript format. “Working” and “Stuck?” may be missing. | 会話ログの形式を読めていません。「作業中」「止まったかも」が出ていない可能性があります。 |
| `foot.ctxFormat` | Can't read context sizes from the transcripts, so they are hidden. | 会話ログからコンテキスト量を読めないため、表示を止めています。 |
| `foot.actFormat` | Can't read tool use from the transcripts, so “doing” labels are missing. | 会話ログから操作を読めないため、「していること」が出ていません。 |
| `foot.diag` | Reading status | 読み込みの状態 |
| `foot.codexSummary` | Codex candidate, recognized, board and lifecycle counts | Codex の候補・認識件数、盤面状態・イベント状態別件数 |
| `foot.codexNoFiles` | No rollout files matched the expected folder and filename pattern | 認識対象の形式に合う rollout ファイルが見つからない |
| `foot.codexNoDetected` | Candidate files exist, but none passed the CLI checks | 候補はあるが CLI の形式条件に合わない |
| `foot.codexNoWorking` | No recent unfinished turn; completed/interrupted are Recent and stale active turns are Stuck? | 新しい未完了ターンがない。完了・中断は「最近」、古い未完了は「止まったかも」 |
| `foot.bad` | {n} file couldn't be read. \| {n} files couldn't be read. | 読めなかったファイル {n} 件。 |
| `foot.missing` | {n} transcript not found (last {days} days). \| {n} transcripts not found (last {days} days). | 会話ログが見つからない {n} 件 (最近 {days} 日)。 |
| `foot.missingWhy` | Sessions that ran remotely or in the cloud have no log on this computer, so their state is unknown. | リモートやクラウドで動いた会話は、このパソコンにログが無いため状態が分かりません。 |
| `foot.allGood` | Everything was read. | すべて読めています。 |
| `foot.disclaimer` | Unofficial. Not affiliated with Anthropic. Claude is a trademark of Anthropic. | 非公式のツールです。Anthropic とは関係ありません。Claude は Anthropic の商標です。 |
| `notify.needs_you` | Needs you: {title} | 返事待ち: {title} |
| `notify.trouble` | Stuck?: {title} | 止まったかも: {title} |
| `notify.many` | {n} sessions need you or may be stuck | 返事待ち・止まったかもが {n} 件 |
| `live.moved` | “{title}” moved to “{pile}” | 『{title}』は「{pile}」に移りました |
| `live.selectAll` | Selected all {n} suggested | おすすめ {n} 件を選びました |
| `live.copied` | Copied the instruction for {n} session \| Copied the instruction for {n} sessions | {n} 件分の指示文をコピーしました |
| `live.nothingPicked` | Nothing is picked | 選ばれていません |
| `live.picked` | Picked: {title} | 選びました: {title} |
| `live.unpicked` | Unpicked: {title} | 外しました: {title} |
| `live.copiedId` | Copied the ID | ID をコピーしました |
| `live.copiedLink` | Copied the link | リンクをコピーしました |

### 19.13 Doing, waiting and short words (§8.4, §10.3)

`{target}` is a file name, a command head, a host or a connector name (shown as `code`); `{note}` and `{step}` are Claude's own words (quoted content, never translated).

| key | en | ja |
|---|---|---|
| `doing.edit` | Editing {target} | {target} を編集中 |
| `doing.edit_bare` | Editing files | ファイルを編集中 |
| `doing.write` | Writing {target} | {target} を作成中 |
| `doing.read` | Reading {target} | {target} を読み込み中 |
| `doing.read_bare` | Reading files | ファイルを読み込み中 |
| `doing.search` | Searching the code | コードを検索中 |
| `doing.run` | Running {target} | {target} を実行中 |
| `doing.run_bare` | Running a command | コマンドを実行中 |
| `doing.test` | Running tests ({target}) | テストを実行中 ({target}) |
| `doing.test_bare` | Running tests | テストを実行中 |
| `doing.git` | Using Git ({target}) | Git を操作中 ({target}) |
| `doing.git_bare` | Using Git | Git を操作中 |
| `doing.web` | Looking things up on the web | Web で調べています |
| `doing.webHost` | Reading a page on {target} | {target} のページを読み込み中 |
| `doing.browser` | Using the browser | ブラウザを操作中 |
| `doing.connector` | Using {target} | {target} を使用中 |
| `doing.connector_bare` | Using a connector | コネクタを使用中 |
| `doing.agents` | {n} helper at work \| {n} helpers at work | サブエージェント {n} 件が作業中 |
| `doing.agents_bare` | Helpers at work | サブエージェントが作業中 |
| `doing.plan` | Updating its plan | 手順を整理中 |
| `doing.wrap_up` | Writing its report | 報告をまとめています |
| `doing.think` | Thinking | 考えています |
| `doing.tool` | Using a tool | ツールを使用中 |
| `doing.step` | Step: {step} | 手順: {step} |
| `doing.note` | “{note}” | 「{note}」 |
| `doing.asOf` | As of {ago}: {doing} | {ago}の時点: {doing} |
| `short.stalled_tool` | Stopped mid-tool | ツールの途中で停止 |
| `short.stalled_prompt` | No reply yet | 返事がないまま |
| `short.limit` | Hit the usage limit | 使用上限で停止 |
| `short.git_startup` | Failed to start | 起動に失敗 |
| `short.not_started` | Never started | 起動しないまま |
| `short.error` | Stopped on an error | エラーで停止 |

### 19.14 Context words (§8.5)

`{used}`, `{window}` and `{at}` go through the pure `tokensText(n)` (format.mjs, own template, no Intl): `n < 1000` → the number; else `k = round(n / 1000)`, `k < 1000` → `{k}K`; else `round(n / 100000) / 10` without a trailing `.0` + `M` (`967K`, `150K`, `1M`, `1.2M`).

| key | en | ja |
|---|---|---|
| `ctx.meta` | context {pct}% | コンテキスト {pct}% |
| `ctx.metaEst` | context ~{pct}% | コンテキスト 約 {pct}% |
| `ctx.due` | time to hand off | 引き継ぎどき |
| `ctx.soon` | summarizes itself soon | まもなく自動で要約 |
| `ctx.compacted` | summarized {ago} | {ago}に要約済み |
| `ctx.copied` | hand-off copied {ago} | {ago}に引き継ぎの指示文をコピー |
| `ctx.afterWork` | hand off after it finishes | 終わってから引き継げます |
| `ctx.answerFirst` | answer its question first | 先に質問に答えてください |
| `ctx.afterLimit` | hand off after the limit resets | 上限が戻ってから引き継げます |
| `ctx.aria` | Context {pct}% full | コンテキストの使用量 {pct}% |
| `ctx.dueCount` | Time to hand off: {n} | 引き継ぎどき {n} 件 |

### 19.15 Hand-off (§9.1–§9.4)

| key | en | ja |
|---|---|---|
| `handoff.open` | Hand off | 引き継ぐ |
| `handoff.openAria` | Hand off: {title} | 引き継ぐ: {title} |
| `handoff.lead` | Hand “{title}” off to a new session (context {pct}%) | 『{title}』を新しいセッションへ引き継ぐ (コンテキスト {pct}%) |
| `handoff.why` | When the context fills up, Claude summarizes the conversation by itself and can lose details. A new session that starts from a written brief keeps what matters. | コンテキストが埋まると Claude が会話を自動で要約し、細かい指示が抜けることがあります。要点を書いた引き継ぎ文から新しいセッションを始めると、大事なことが残ります。 |
| `handoff.step1` | Copy and open | コピーして開く |
| `handoff.step2` | Paste it into the session that opens, and send | 開いたセッションに貼って送る |
| `handoff.step3` | Claude shows a brief and asks whether to start the new session. Answer in the app | Claude が引き継ぎ文を見せ、新しいセッションを始めてよいか聞くので、アプリで答える |
| `handoff.copyOpen` | Copy and open | コピーして開く |
| `handoff.copyOnly` | Copy only | 指示文だけコピー |
| `handoff.close` | Close | 閉じる |
| `handoff.text` | Text to copy | コピーする指示文 |
| `handoff.copied` | Copied. Paste it into “{title}” and send. | コピーしました。『{title}』に貼って送ってください。 |
| `handoff.rescueBtn` | Copy for a new session | 新しいセッション用にコピー |
| `handoff.rescueLead` | “{title}” may be too full to answer | 『{title}』はコンテキストがいっぱいで、答えられないかもしれません |
| `handoff.rescueLeadCheck` | If “{title}” stays stuck after you check on it, it may be too full to answer | 確かめても『{title}』が止まったままなら、コンテキストがいっぱいで答えられないのかもしれません |
| `handoff.rescuePaste` | Start a new session in the same folder, paste it there and send. | 同じフォルダで新しいセッションを作り、そこに貼って送ってください。 |
| `handoff.whyStuck` | check on it first | 先に様子を見てください |
| `handoff.whyUnknown` | its context size isn't known | コンテキストの量が分かりません |
| `handoff.l0` … `handoff.l6` | §9.4, one line each | §9.4、1 行ずつ |
| `handoff.rescue.l0` … `handoff.rescue.l2` | §9.4, one line each | §9.4、1 行ずつ |
| `live.handoffNo` | Can't hand off now: {why} | いまは引き継げません: {why} |

## 20. Data from /api/board v2

Everything the UI reads. Fields not listed are not used by the UI. `folders` hints are adapter-internal and never reach the JSON.

| element | fields |
|---|---|
| version check (api.mjs) | `v` (must be 2), `counts` (must be an object) |
| clock offset, dateline | `serverNow` |
| ledger, tab title, favicon, lede calm lines | `counts.needs_you`, `.trouble`, `.unread`, `.working`, `.recent`, `.cleanup`, `.recommended`, `.active`, `.archived` |
| lede (busy / stuck / unread) | `buckets.<pile>[0]`: `id`, `title`, `body`, `since`, `timeKind`, `reason`, `reasonParams` (`ask`, `via`, `reset`, `error`) |
| Needs you, Stuck?, Unread, Working rows | `buckets.<pile>[]`: `id`, `bucket`, `reason`, `reasonParams`, `title`, `body`, `since`, `timeKind`, `startedAt` (Working only, optional), `project.{key,label,extra}`, `prs[].{num,repo,state}`, `routine.{runs,completed,stalled}`, `family.{rootId,parentId,parentTitle,children}` |
| Recent | `recentGroups[]`: `key`, `label` (null = no project folder), `items[]` (Card as above) |
| To archive | `cleanupGroups[]`: `reason`, `recommendedReason`, `count`, `recommendedCount`, `items[]` or `projects[]` (`key`, `label` null = no project folder, `lastActivityAt`, `count`, `recommendedCount`, `items[]`); cards add `cleanup.{recommended, note}` (NoteCode), `routine.{runIds, latestBucket}`, `reasonParams` (`older`, `total`, `latestBucket`, `prs`, `more`, `error`, `question`), `lastActivityAt`, `since`, `timeKind` |
| doing line, `asOfText`, `shortDoing` (§8.4, §10.3) | `activity.{kind, target, n, note, step, live, at}` (optional; never on Needs you or To archive cards) |
| context words, hand-off (§8.5, §9) | `context.{used, window, inferred, pct, compactAt, level, compacted.{at, trigger}}` (optional; never on To archive cards), `detail.contextExceeded`, `lastActivityAt` (the 24 h row rule) |
| detail panel | `detail.{statusDetail, branch, worktreeName, gitWorktree.{branch,status,changed,untracked,conflicted,locked,prunable}, completedTurns, error, prsMore, contextExceeded}`, `prs[].{num,repo,state,url}`, `createdAt`, `routine.{completed,stalled,runs}`, `family.*` |
| family tree, family filter | `families[rootId].{title, memberIds}`, every card's `family.parentId`, `createdAt`, `bucket`, `routine.runIds` |
| canvas (`buildSheets`, slips) | every card in `buckets`, `recentGroups` and `cleanupGroups` with its `id`, `bucket`, `title`, `body`, `since`, `timeKind`, `startedAt`, `project.{key,label}`, `lastActivityAt`, `createdAt`, `family.{rootId,parentId}`, `detail.{branch,worktreeName}`, `prs`, `activity`, `context`; `families` |
| notices, footer | `stats.formatSuspect` (null \| 'no_timestamps' \| 'no_session_files'), `stats.demo`, `stats.archived`, `stats.bad`, `stats.transcriptsMissingRecent`, `stats.transcriptsDirMissing`, `stats.unknownTurnRecent`, `stats.recentWithTranscript`, `stats.contextSuspect`, `stats.activitySeen` (`stats.contextSeen` is for smoke only), optional path-free `stats.worktrees.{scanned,matched,unavailable,skipped}` |
| batch progress, selection pruning | the set of every card ID plus every `routine.runIds` member (present IDs), and the cleanup subset |

New in v2 for the UI: `reasonParams` (replaces `reasonText`), `cleanup.note` as a code, `project.label: null`, `startedAt`, `stats.formatSuspect`, `stats.demo`. Added in v0.2 (still `v: 2`; optional, additive, ignored by a v0.1 page): `activity`, `context`, `detail.contextExceeded`, `stats.contextSeen`, `stats.activitySeen`, `stats.contextSuspect`. HTTP 500 carries `{"error":"board_failed"}` (the UI shows its own words).

## 21. Tests and acceptance

Unit tests (`node --test`, synthetic data, both languages):
- `format`: every `reasonLine` case in en and ja; `timeText` for every kind and its `_now` form; `durationText` short and long, n = 0, 1, 2; `parseResetTime` (`resets 1:50pm`, `resets at 13:00`, `resets 9am`, unparsable → null); `contentLang`; `tabTitle` (needs, stuck only, none, offline); `dateline`; `matches` finds a Stuck? card by its rendered reason and a no-folder card by `project.other`; `archiveInstruction` is 3 lines + one ID per line in both languages.
- `ui-state`: `planCopy`, `commitCopy`, `pruneSelection`, `reselectIds`, `batchProgress` (0, partial, done, stale at 2 min), `checkState`, `nextUp` (needs > stuck > unread, oldest first), `cursorAfter` (same pile, moved pile, emptied pile, and on visible rows via `listsFromRows`), `stalePrefKeys`, `stepOf`.
- `cleanup`: `applyPick` with the filtered model touches only visible rows; `hiddenPicks` counts closed and filtered picks.
- `format` (v0.2): `tokensText` (`999` → `999`, `150000` → `150K`, `967000` → `967K`, `999600` → `1M`, `1000000` → `1M`, `1200000` → `1.2M`); `doingSpec` for every kind with and without a target (`agents` with `n` 1 and 2, unknown kind → `doing.tool`); `doingMainSpec` uses the note only for `run`/`test`/`git`; `doingText` with a step; `asOfText` without `at` → `''`; `shortDoing` for every pile and reason; `contextMeta` at no level, notice, notice inferred, due, soon, and with a compaction inside and outside `COMPACT_SHOW_MS`; `contextValueText`; `matches` finds a card by its doing phrase, by a target, by its step, and by 「引き継ぎ」 / "hand off" at the due level.
- `handoff`: `handoffText` is 7 lines in both languages with `{pct}` filled and no `{` left; `rescueText` is 3 lines with `{id}`; `handoffPlan` for every pile × level (none, notice, due, soon) × age (23 h, 25 h) × stored state, the rescue rule (`soon`, `contextExceeded`), the `why` keys; `handoffArmed` re-arms at +5 points, at a newer compaction and after 24 h, and not at +4; `dueIds` order (pct descending, ties by ID) and only cards with a guide (Working, Needs you, Stuck? at the limit and To archive left out); `pruneHandoffs` drops entries older than 24 h; `latchHandoffs` drops a record after a newer compaction or a drop of `REARM_PCT` points and returns the same map when nothing changed.
- `canvas-layout` (`test/canvas-layout.test.mjs`): bands and oldest-first / newest-first order; a family travels to its most urgent member, parent first, tree order inside; keep-together and backfill; a family longer than a row wraps; faded To-archive members of a live family (never slips; a project with only those is folded); only Needs you, Stuck?, Unread and Working are slips, Recent and To archive are counted on the band line (one line at any count; a sheet with no slips is head and band); a family's slips stay together and `up` marks a child joined to its parent; archive-only projects folded (count order, below the lowest sheet, inside the bounds); `colsFor` never makes an empty column and honours `maxCols`; `cols` fixed by the seat; `urgencyRank` order; `pack` is deterministic, overlap-free within `W` and reads in urgency order (shelves), and its shelf width shows the desk at least as large as one shelf or the √area width (the fold block counted); `settle` places a new project without moving seated ones and keeps vanished seats 7 days; kept heights: a Recent ⇄ Working flip moves the other sheets and the fold at most once, a second flip moves nothing, `dropSheet` resets the dropped sheet's kept height; `pushDown` moves only down and leaves no overlap; `dropSheet` snaps and pushes, and a drop into a neighbour's margin (up, sideways) or onto its lower part leaves the neighbour in place; property test: 60 random drops move no other sheet sideways or up, move no sheet above the dropped one, and land exactly on a free spot; `parseSeats` rejects every wrong shape (a bad `h` too) and v 1 docs, and accepts a seat without `h`; `readingOrder` and `neighbour`; property test: 200 random boards with bucket flips over the same seats → no sheet changes x or width, no two sheets overlap; a 300-session board settles in under 5 ms.
- `ui-canvas` (`test/ui-canvas.test.mjs`): `canvasKeyAction` honours IME, modifiers, inputs, dialogs and the off switch, and maps every key of §10.8 per target; `levelOf` at 0.59 / 0.6 / 0.99 / 1; `stepZoom` up and down from off-step values; `zoomAt` keeps the point under the pointer; `fitRect` never above 1, and fits the height down to `FIT_MIN` only, at every width; `colsCap` per width; `openCamera` fits the non-quiet sheets clamped to 0.62–1 from the top left and reveals the lede, else fits all; `headPin` pins a head whole from the moment the viewport top would cut it, and hides the sheet when less than `LEAVE_PX` of it would show under the head; a synthetic 14-project board (7 archive-only, the lede on a 1-slip sheet, Recent-heavy sheets, 30–40 code-point titles) opens at 0.62 or more with most urgent slips and the lede on screen, titles fitting two lines, no empty column, no head cut at the viewport top and only the four slip piles as slips, and stacks in one column at 490px; `revealRect` pans the least; `canvasSig` ignores times; Enter and Space on a running head open the sheet state, also with the off switch.
- `ui-list` (`test/ui-list.test.mjs`): `familyText`; the tokens' contrast against design.md §3.1 in both themes and the dark readability floors; design.md §3 equals `tokens.css`; no 350 body weight; no `·` joiner in the screen's code or dictionaries (design.md §9 rule 6); the lede quotes nothing at any width and the family link does not wrap.
- `i18n`: same keys and the same placeholder set per key in `EN` and `JA` (plural forms included); no empty strings; plural objects only in `EN`; the dictionary parts (`dict-<lang>-*.mjs`) repeat no key; `detectLang` (`?lang`, saved, `navigator.languages` with `ja-JP` first, `fr` → `en`).
- `keys`: `keyAction` ignores IME composition, modifiers, inputs and dialogs; the off switch keeps Enter/Esc and the arrows and silences `h`, `v`, `z`; Shift with a printable key keeps the character (`/`, digits); `h`, `v` and `z` map to their actions and ignore repeats.
- `rows`: `detailStamp` ignores unrelated cards and changes with the family tree, the language, the day and the card's hand-off copied state. `state`: `pruneNew`, `reselectLeft`, `prefs.handoff` and `prefs.view` survive a broken or missing storage (defaults).
- `favicon`: `faviconKind`; `faviconHref` contains the accent only for `needs`.
- `notify`: `arrivals` is empty on the first board and ignores Unread.

Acceptance (screenshots with the demo server on a free port in 18950–18989, `?lang=en` and `?lang=ja`, light and dark, list and `?view=canvas`):
- 1280, 768, 400 and 320 px: no horizontal scroll; no control label wraps to two lines (a link that holds a session title, such as the parent link, may wrap, since titles never truncate; a sub-group toggle puts its time on its own line below 24rem by design); at 400×800 the first Needs-you row starts at or above 520px, also with a fresh profile (first run).
- Every state in §5 and every notice in §7 rendered once (the demo plus fault injection in tests).
- A synthetic 300-session board: the canvas far level shows marks, never a solid block, and panning stays smooth (one transform per frame); To archive scrolls smoothly; the selection bar never covers a focused row.
- Keyboard only, list: j/k through every pile, Enter opens, Space peeks, x/a/c through a full copy, `h` + Enter copies and opens on a due Unread row, `v` and `z` into the canvas and `v` back, Esc never drops the selection.
- Canvas: no page scroll at 1280, 768, 400 and 320; no button wraps; far, mid and near each readable and nothing below 13px at any zoom (computed font size × z); on open, the urgent sheets from the top left at 62 % or more (the side pane at about 100 %), with the Needs-you slips in the front row; Tab through every head and slip group; j/k across sheets; arrows move spatially; Shift + arrows move a sheet; `f`, `z`, `0`, `+`, `−`; `h` + Enter copies and opens; Esc closes the bar; dragging a sheet onto another moves the other down, a reload keeps the places, Rearrange gives the same picture twice; the demo rebuild every minute moves no sheet sideways.
- Privacy: screenshots use the demo only; nothing in a screenshot, test or log comes from real sessions.

### 10.11 User-authored graph cards and relations

- The canvas offers local cards for tasks, artifacts, decisions, worktrees, comprehension gaps and execution profiles. They are authored by the user, stored only in browser localStorage, and are never sent through the board API. The graph model is an allowlist; unknown fields are discarded and counts and text lengths are bounded.
- An execution profile records only fixed choices for location (unknown/local/WSL/remote), workspace isolation (unknown/sandboxed/not sandboxed), network access (unknown/restricted/available) and approval mode (unknown/per action/on demand/automatic). Every field defaults to unknown. These are manual declarations, not detected settings; the profile does not read session files, environment variables, or app configuration. It can be related to a session like any graph card.
- Artifact cards can hold one user-entered HTTPS reference. Credentials, query strings, fragments, non-HTTPS schemes and overlong values are rejected. The reference stays in browser localStorage and is not fetched; a link opens a new tab only after an explicit click.
- An Obsidian-note card stores only a user-entered vault name and vault-relative note path in browser localStorage. Absolute paths, traversal segments and URL-like query/fragment values are rejected. It does not scan vaults or read/write notes. A properly encoded `obsidian://open?vault=…&file=…` link is offered only for explicit user activation; tests never activate the external protocol. This is a manual reference layer, not vault indexing or knowledge extraction.
- REA findings use the existing artifact card: the user reviews the REA result, manually enters a short summary (artifact description capped at 1,000 characters), then connects the card to relevant tasks, decisions or sessions. Pigeonholes never runs REA or imports full Evidence; it cannot inspect the summary's meaning for secrets, so the person entering it is responsible for keeping sensitive content out.
- A successful explicit worktree creation adds a `worktree` card to that graph with branch, base and safe creation-time status counts. It is a local snapshot record, not a live registry; editing or deleting it never changes Git state.
- Cards can be moved with pointer drag or focused-card arrow keys; click / Enter opens an editor. New cards take the first open position around the current view center so they do not cover earlier graph cards. Position, text, status, and links survive reload. Fit all includes graph cards. Existing project sheets and session slips remain in place.
- Search dims graph cards whose safe user-authored text does not match. Cards and lines remain visible to preserve context. Deleting a card requires a browser confirmation and removes its linked relations.
- Relations connect graph cards and currently visible session IDs from the supported providers. Session pickers and relation labels show provider plus an opaque short ID, never a session title, prompt, path, tool input/output, environment value, or credential. A relation records type, purpose/evidence, and, for delegation records, status. It never invokes a CLI, agent, worktree, or external service.
- Relation records can be edited without changing their endpoints, and can be removed only after an explicit confirmation. The model rejects duplicate edges after edits.
- A comprehension-gap card records the person whose understanding is being checked, missing evidence, and needed explanation. The product computes no comprehension score. The graph can represent related, dependency, evidence, explanation, and delegation-record edges.
- The graph review marks only an explicitly described missing-evidence or needed-explanation item that lacks its corresponding `evidence` or `explains` relation. It says the graph link is missing; it does not infer a person's understanding. The card and editor badges update when those relations change. The card editor points to the missing relation, and a user can add it and then change the card status after review.
- Session details list linked graph cards and linked sessions with relation direction, type, delegation status, and purpose/evidence. A linked graph card opens its editor; a linked session opens that session's detail panel. Session-to-session labels contain only provider and an opaque short ID, never the session title or transcript.
- If a linked graph card is an Obsidian-note reference, the session detail also offers a clearly labeled `Open in Obsidian` link. It is built client-side from the local graph record and is never added to session projections or API responses. It opens only after explicit activation; the relation entry itself contains only the card's safe title/kind/ID projection.
- When an execution-profile card is related to a session, the session detail shows the card title and its four fixed, user-declared values. The detail projection includes only the profile ID/kind/title and allowlisted enums; it never includes card body, URL or unknown properties. These values are labeled as manual and are not presented as runtime-verified facts.
- When a comprehension-gap card is related to a session, the detail shows the person whose understanding is being checked, the explicitly missing evidence and the needed explanation. Graph cards and provider-scoped opaque session IDs connected through `evidence` and `explains` edges are keyboard-accessible buttons that open the linked graph editor or session detail. A short-ID collision disables resolution by failing closed. It does not score or infer that person's understanding. The detail projection excludes card body, URL and unknown properties and never renders a full session ID.
- Session details offer an explicit worktree creation dialog. It shows project, base branch, safe current status/flags, new branch input, and that uncommitted changes are omitted; a required acknowledgement calls the same-origin operation API. Git hooks are disabled, possible checkout filters are disclosed, and the result contains branch and safe status counts only. The dialog explains errors and the synthetic demo always disables creation. It never starts a CLI session.
- Session details can refresh a read-only inventory of up to 20 local worktrees in the selected repository. Each row shows only a branch (or detached HEAD), current-session marker, safe status counts, and locked/prunable flags. No path or lock reason crosses the adapter boundary; an empty result explains that the session may not be in a Git repository or Git returned no local worktrees.
- A listed worktree can be recorded locally on the canvas and linked to its source session. Re-recording the same branch for that session refreshes the existing card's safe summary rather than adding a duplicate. This does not create, change, or delete Git worktrees.
- A removal action appears only for a branch worktree reported clean, non-current, unlocked, and non-prunable. It opens a second dialog that names the branch, explains that the working directory (including possibly ignored files) will be removed while the branch stays, requires typing the branch name and checking an acknowledgement, then sends a same-origin request. The adapter rechecks the target and invokes `git worktree remove` without force; the demo and unsupported states disable it. Session files remain read-only.
- After successful creation, the browser-local graph stores a `worktree` card with branch, base branch, and the safe status counts at creation, linked to the source session. This is a user-facing record, not a live worktree registry; editing or deleting the card does not change Git state. If graph storage fails after Git succeeds, the dialog says the worktree exists but its card was not saved.
- A session detail action can create a task with a safe, user-editable default title and a `related` edge to that session in one localStorage write. It copies no session title, prompt, transcript, path, or tool content; if either record cannot be validated, neither is saved.
- A compact masthead filter panel offers source, state, and project selectors. Source choices cover Claude Code, Codex CLI, GitHub Copilot, OpenCode, and all sources; state choices cover the six board piles; project choices use the safe project label. All three compose with text search. The list shows only matching rows and the canvas dims nonmatching session slips while keeping project sheets in place. The result count updates, and clearing filters resets all selectors.
- Session details label the observed provider/source: Claude Code app-session records, Codex CLI records with the accepted CLI markers, GitHub Copilot `session-state` records, and OpenCode database records. Copilot's CLI and app share a local store, and the OpenCode adapter does not identify the producing client; those labels do not prove which UI or CLI created a session. Other execution settings are available only as manually entered profiles, not detected runtime facts.
- OpenCode source diagnostics use counts only and explain missing database, unsupported schema, zero recent work, or an unsupported Node runtime. The adapter reads only the V2 session index, parent IDs and timestamps plus user/idle event times and idle outcomes. Unknown idle outcomes leave lifecycle state unknown. Prompt contents, tool payloads, auth data, database paths and raw provider IDs are not returned.
- Session details with no allowlisted event rows explicitly say that no safe event summaries are available; unsupported event codes and malformed timestamps are omitted from the rendered timeline.
- Save failures are announced. Dialogs use native modal semantics, labels, visible focus, bounded inputs, and a small-screen width. Graph keys and user-facing strings live in the established canvas dictionaries.
- Verification for this stage: synthetic model/storage tests, architecture checks, and a demo-browser walkthrough for add/edit/move/connect/filter/reload. Source, state, project, and text filters were combined against synthetic demo data; the list shows the matching state and the canvas dims nonmatching slips while retaining project sheets. Real sessions are not needed to test placement persistence; session endpoint visibility remains bounded to whatever the local read-only board already exposes.
- Execution profiles were checked in the synthetic demo: all four selectors started at unknown, a user-authored profile could be linked to a synthetic session, and both its fixed values and relation remained after reloading. This validates only browser-local profile behavior; it does not validate that a declared setting matches any runtime.
