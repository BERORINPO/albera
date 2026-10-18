# Pigeonholes: screen spec (v1)

Status: locked for v0.1. The look (tokens, type, motion, voice) is `spec/design.md`. Classification and the API are `spec/board.md`. This text is the source of truth for the screen. Rules that came out of design review: Open is never hover-only, every time carries its state word, the paste step is the headline after copying, diagnostics sit behind a toggle.

Contents: 1 files · 2 page skeleton · 3 layout by width · 4 masthead · 5 the first 3 seconds · 6 counts ledger · 7 board notices · 8 piles and rows · 9 detail panel · 10 Overview · 11 filtering · 12 cleanup flow · 13 notifications, favicon, tab title · 14 keyboard · 15 focus and re-rendering · 16 updates and time · 17 language · 18 first run, help, footer · 19 copy deck · 20 data from /api/board v2 · 21 tests and acceptance.

---

## 1. UI files

Every file is under 400 lines, `// @ts-check`, vanilla ESM, no dependencies. Only `api.mjs` calls `fetch`. Nothing uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `style` attributes (CSSOM `style.setProperty` is fine). Modules marked **pure** touch no DOM, no storage and no clock at import time and are tested with `node --test`. Browser modules import shared code as `../src/shared/constants.mjs` and `../src/shared/i18n.mjs` (served at those paths).

| file | role | main exports |
|---|---|---|
| `public/index.html` | static skeleton (§2), English first paint, `data-i18n` hooks, `<meta name="pigeonholes" content="1">` | — |
| `public/tokens.css` | design tokens, byte for byte from design.md §3 | — |
| `public/style.css` | base, controls, masthead, front (lede, ledger), page grid, banners, footer, dialogs, motion and reduced motion | — |
| `public/rows.css` | pile heads, rows, row detail, family tree, Working two-column rule | — |
| `public/tidy.css` | the To archive pile: steps, select-all, groups, sub-groups, cleanup rows, selection bar | — |
| `public/overview.css` | the Overview: legend, shelves, marks, quiet fold | — |
| `public/app.mjs` | boot: resolve language, load prefs, build static text, wire one delegated `click`/`change` listener and `keys.mjs`, start the poll loop (`poll.mjs`) and the minute tick | `init()` (runs on import) |
| `public/poll.mjs` | the poll loop (§16): a fetch failure (offline, server, version) is told apart from a failure to draw a 200 board | `poll()`, `schedule()` |
| `public/api.mjs` | the only `fetch`: `GET /api/board` with `If-None-Match`, timeout, `v === 2` check | `fetchBoard(etag, timeoutMs)`, `BoardHttpError`, `BoardVersionError` |
| `public/state.mjs` | the single in-memory state object and its setters; prefs in localStorage `pigeonholes:v1:ui` (every read and write in try/catch) | `state`, `loadPrefs()`, `savePrefs()`, `setBoard()`, `pruneNew()`, `snapshot()`, `restore()`, `setCursor()`, `pick()`, `unpick()`, `startBatch()`, `reselectLeft()` |
| `public/ui-state.mjs` | **pure** selection, copy, batch, cursor and lede logic | `planCopy`, `commitCopy`, `pruneSelection`, `reselectIds`, `batchProgress`, `checkState`, `nextUp`, `cursorAfter`, `listsFromRows`, `stalePrefKeys`, `focusSignature`, `stepOf` |
| `public/render.mjs` | render orchestrator: masthead texts, piles shell, footer, tab title, favicon, keeping focus | `render()`, `renderTimes()` |
| `public/front.mjs` | lede (all states), counts ledger, board notices, first-run legend | `renderFront()`, `renderBanners()`, `renderIntro()` |
| `public/rows.mjs` | rows of Needs you, Stuck?, Unread, Working, Recent; detail panel; family tree | `renderPile()`, `renderRecent()`, `rowEl()`, `detailEl()`, `familyTree()` |
| `public/cleanup.mjs` | the To archive pile and the selection bar | `renderCleanup()`, `renderSelbar()`, `hiddenPicks()` (pure), `applyPick(el, visible)` |
| `public/overview.mjs` | the Overview: **pure** model + DOM + roving focus | `overviewModel(board, visible, prefs)` (pure), `overviewSig()` (pure), `overviewKey(ev, keysOn)` (pure), `renderOverview()`, `focusMark()` |
| `public/keys.mjs` | keyboard map (§14), help dialog, single-key off switch | `keyAction(ev, ctx)` (pure), `bindKeys()`, `openHelp()` |
| `public/notify.mjs` | opt-in notifications | `arrivals(prev, board)` (pure), `notifyArrivals()`, `notifyState()` |
| `public/favicon.mjs` | status favicon | `faviconKind(counts)` (pure), `faviconHref(kind)` (pure), `setFavicon(kind)` |
| `public/copy.mjs` | clipboard write with fallbacks and the fallback `<dialog>` | `copyText(t, text, opener)` (t: the dictionary, for the fallback dialog) |
| `public/view.mjs` | DOM helpers | `h()`, `reconcile()`, `partsToNodes()`, `announce()`, `setText()` |
| `public/format.mjs` | **pure** text: every function takes `t` first | `durationText`, `timeText`, `reasonLine`, `projectLabel`, `contentLang`, `parseResetTime`, `matches`, `archiveInstruction`, `prLabel`, `childrenText`, `routineHistory`, `tabTitle`, `dateline`, `absoluteTime`, `deepLink` |
| `public/i18n.mjs` | `makeT(lang)`, `detectLang({search, saved, languages})`, `DICT = {en, ja}` | — |
| `public/dict-en.mjs` | English dictionary (§19), one key per line | `EN` |
| `public/dict-ja.mjs` | Japanese dictionary (§19), one key per line | `JA` |

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
  <link rel="stylesheet" href="/tokens.css"> <!-- then style.css, rows.css, tidy.css, overview.css -->
  <script type="module" src="/app.mjs"></script>
</head>
<body>
<div class="board" id="top">
  <header class="masthead">wordmark · trust · dateline · demo · filter · language · ?</header>
  <div id="banners"></div>                      <!-- board notices, §7 -->
  <section class="front" id="front">lede (h1) + counts ledger (nav) + Overview toggle</section>
  <section class="overview disclose" id="overview" aria-labelledby="ov-h" inert><div class="disclose__in"></div></section>  <!-- closed = inert, opened by .is-open (§10) -->
  <main class="pages" id="pages">
    <div class="page page--now">needs_you · div.side (trouble, unread) · working</div>
    <div class="page page--archive">div#intro (first-run legend, §18) · recent · cleanup · div.selbar</div>
  </main>
  <footer class="foot" id="foot"></footer>
</div>
<p class="vh" id="live" aria-live="polite"></p>
<p class="vh" id="title-keys" data-i18n="row.keysHint"></p>   <!-- the description of every row title (§8.3) -->
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
| 24–40rem (400, Claude's side pane) | wordmark, filter, language, ? (dateline hidden; the demo label sits on the double rule at the end like a stamp, so it takes no room and moves no row; the footer also says demo) | same as 768 | one column, gutter 16px | as 768, at most 2 lines tall: lead + buttons; the how-to line is hidden; the copied text is a closed `<details>` |
| < 24rem (320) | wraps: row 1 wordmark … language ?; row 2 the filter at full width (the demo label as at 400) | same | same; a row's Open moves to its own line so the meta links keep the full width | one column: lead, then the buttons |

- At 400×800 the first Needs-you row starts at or above 520px (target: about 490px), on the first run too (the first-run legend is not on the row path, §18). The front never gets a second lede, a prose summary or a strip of marks below 40rem.
- Pile heads are `position: sticky; top: 0` with `--color-paper` behind them. `html { scroll-padding-top: var(--head-h); scroll-padding-bottom: var(--bar-h, 0px) }` keeps a focused or cursor row out from under a head or the bar (WCAG 2.4.11). `--head-h` is the height of the tallest visible pile head (one ResizeObserver on every head); when no head is visible the property is removed so the CSS default (3.25rem) applies, never 0. The selection bar has an opaque background; nothing shows through it.
- No side column is sticky. The Overview is in the flow (§10).

## 4. Masthead

Left to right: wordmark link (`href="#top"`, aria-label `mast.home`) · trust line (`mast.trust`, ≥ 60rem) · dateline (`date.asOf`, ≥ 40rem) · demo label (`mast.demo`, only when `stats.demo`; in the line from 40rem, a stamp on the double rule below) · filter (`input type=search`, visually hidden label `filter.label`, placeholder `filter.placeholder`, a `kbd` "/" inside the field's end) · language text button (§17) · "?" text button (aria-label `mast.help`, opens the help dialog). A 3px double rule closes it. It is not sticky.

The dateline is the time of the last successful fetch (200 or 304), rewritten only when the minute changes: `Sun 18 Oct, as of 14:52` / `10 月 18 日 (日) 14:52 時点` (own templates, no Intl). When the last success is older than `STALE_AFTER_MS` (15 s), it becomes `date.stale` (`data from 40 s ago` / `40 秒前の内容`), using short units with seconds.

## 5. The first 3 seconds (the lede)

`nextUp(board)` (pure) picks the lede card: the first card of `buckets.needs_you` (oldest wait), else of `trouble`, else of `unread`. The lede ignores the text and family filters. Its row in the list is marked `.is-next` (accent square in the mark column, accent time). The lede's Open is the only filled button on the page.

| state | h1 | line under (accent, 700) | quote / reason | action row |
|---|---|---|---|---|
| **busy** (needs you ≥ 1) | `lede.answer` | `lede.waiting` (`_now` under 1 min), long units | the question as a `<q lang>` in the display face (`--text-md` from 40rem); if `body === ''`: `ask.<reasonParams.ask>` unquoted | [`open.text` `Enter`] filled + `lede.more.needs_you` when more than one |
| **only stuck** (needs you 0, stuck ≥ 1) | `lede.check` | `lede.stalled` (timeKind stalled) or `lede.stopped` / `_now` | `reasonLine(t, card)` | [`open.text` `Enter`] + `lede.more.trouble` |
| **only unread** (needs 0, stuck 0, unread ≥ 1) | `lede.read` | `lede.ended` / `_now` | body, 2 lines clamped | [`open.text` `Enter`] + `lede.more.unread` |
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
- Long titles (> 40 characters) add `.lede--long` (cap at `--text-lg`). The title in the lede clamps to 3 lines.

## 6. Counts ledger and the Overview toggle

A `nav` (aria-label `ledger.aria`) of six links in the fixed order Needs you, Stuck?, Unread, Working, Recent, To archive: `label …dotted leader… number`. Each link scrolls to its pile, opens it if collapsed (Recent, To archive) and puts the cursor on its first row (same as keys 1–6).

- Needs you, Stuck? and Unread with a count > 0 are bold ink (`.is-act`). A zero count stays in place in `--color-muted` (`.is-zero`); the layout never jumps. No accent in the ledger.
- ≥ 60rem: one column with hairlines between items, an ink rule above, and the total line `ledger.total` with the number `counts.active` (`ledger.totalNoArchived` when nothing is archived), closed by the double rule.
- < 60rem: 2 columns × 3 rows (column flow), no total line.
- While a text or family filter is active, every number is the matched count and the total line reads `ledger.match`.
- **Overview toggle**: a text button right under the ledger (start-aligned), `ledger.overviewOpen` + `kbd` z, or `ledger.overviewClose` + `kbd` z when open. `aria-expanded`, `aria-controls="overview"`. Its state is remembered (`prefs.overview`, default false).

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
| Working | newest write first (`since` descending) | first `PREVIEW.working` (8), then [`list.more`] | none | `time.running` when `startedAt` is present, else `time.updated` |
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
  p.row__body > span.t               body / reason (2-line clamp; 1 line in Recent); none in Working
  p.row__meta                        13px muted items separated by column-gap (below)
  a.row__open                        "Open ↗", always visible (bottom right of the row)
  div.row__detail#d-<id> (inert)     §9, built on first open
```

- **Title**: 700 in Needs you, Stuck?, Unread; 400 in Working and Recent. Empty → `untitled`. The title's `.t` gets `lang` from `contentLang(title)` when it differs from the UI language. Clicking the title (or Space) toggles the detail; the body unclamps in place when open.
- **Open**: `a.row__open` with `href = deepLink(id)` (`claude://claude.ai/epitaxy/<id>`), text `open.row`, `aria-label` `open.aria`, `title` `open.title` (`open.demoTitle` in the demo, whose IDs do not exist in the app), a `::before` overlay for a 44px target. Ink-2 13px in every pile (accent on `.is-next`). It is never hidden by hover, opacity or `display`. When the ID does not match `SESSION_ID_RE`: no `href`, `aria-disabled="true"`, muted, `title` `open.disabled`.
- **Meta items** (in this order, each only when present): project (`projectLabel`; "No project folder" muted, `title` = `project.otherGloss`; left out inside Recent groups) · parent link `family.parent` (`button.link` → family filter; `family.parentMissing` when `parentTitle === null`, `untitled` when `''`) · children `family.childrenWith` / `family.children` (`button.link` → family filter; parts with count 0 left out, joined by `sep.list`) · open PRs only, up to `MAX_PR_BADGES` (2), `prLabel` · routine `routine.runs` (+ on the latest run when `stalled ≥ 2`: `routine.flaky` in ink) · Working with `reason === 'background'`: `reason.background`; `reason === 'starting'`: `reason.starting` · Working quiet hint `row.quietHint` in ink-2 when `now − since > QUIET_HINT_MS` (5 min) · `badge.new` for `NEW_BADGE_MS` (60 s) after the row arrived in Needs you, Stuck? or Unread (not on first paint) · `row.copied` when its ID is in the copied set.
- **Cursor row** (`.is-cursor`): `--color-paper-2` band and the margin triangle. **Next row** (`.is-next`): the accent square. No other row decoration: no stripes, tags or per-row state icons.
- **Arrival**: a row newly in Needs you, Stuck? or Unread (bucket+id pair not in the previous board) gets `.is-new` (the arrive primitive) and the `badge.new` word.
- Working rows use `--space-xs` padding and a muted time. When the Working pile is at least 44rem wide (container query), its rows flow in two columns.
- Rows below the fold in To archive use `content-visibility: auto; contain-intrinsic-size: auto 4.5rem` (300-row case).

## 9. Detail panel

Opened by the title button or Space; `grid-template-rows: 0fr → 1fr` (disclose), `inert` while closed, built on first open and kept by ID across re-renders. A changed card rebuilds its whole row; otherwise the detail is rebuilt only when `detailStamp` changes (language, the local day, and the family tree's members with their piles, titles, creation and parents), so text selected in it and a "Copied ✓" label survive other cards' updates. Its state time is a `time[data-kind]` that the minute tick rewrites. A dotted rule above, 13px, a `dl` that stacks below a 22rem container and turns into two columns (labels 5.5rem) from 22rem; the container is the pile.

Rows of the `dl`, each only when present:

1. `detail.state`: `detail.stateValue` = pile name + the row's time text (`作業中 (たった今更新)` / `Working (updated just now)`).
2. `detail.summary`: `detail.statusDetail` as `<q lang>`.
3. `detail.error`: `detail.error` (full error, pre-wrap), for Stuck? and `old_error`.
4. `detail.branch` / `detail.worktree`.
5. `detail.folder`: `detail.cwd` in mono, `overflow-wrap: anywhere`.
6. `detail.created`: `date.today` when today, else `absoluteTime` (`YYYY-MM-DD HH:mm`).
7. `detail.turns`: `detail.turnsValue`.
8. `detail.routine`: `routineHistory(t, routine)` (+ `routine.flaky`).
9. `detail.pr`: up to 10 lines `pr.detail` (open first; state words from `pr.state.*`, unknown states raw); a link only when `url` is non-null (`rel="noopener noreferrer"`, `target="_blank"`); `detail.prsMore` → `pr.more`.
10. `detail.related`: the family tree (below).

Actions (text buttons, one row): [`open.row`] (only in To archive rows, which have no row-level Open) · [`detail.familyOnly`] (when in a family) · [`detail.copyId`] · [`detail.copyLink`]. A copy button's label becomes `detail.copied` for `COPIED_LABEL_MS` (2.5 s); no toast.

**Family tree** (`ul.tree`, aria-label `detail.relatedAria` with the root title): built from `families[rootId].memberIds` and each member card's `family.parentId`. Cards are found across all buckets, recent groups and cleanup groups; a routine row stands for every ID in its `runIds`. Root first, children nested under their parent (by `createdAt` ascending), depth ≤ `FAMILY_MAX_DEPTH`, at most 12 nodes, then `detail.treeMore`. Each node: title + the pile name it is in (muted, right). The row's own node is bold with `detail.self`. Every other node is a `button` that jumps to its row (the same `jumpTo(id)` as the Overview). Members without a card count into `detail.treeMore`.

## 10. Overview ("全体 / Overview")

An optional zoomed-out view: every visible session as one small mark on its project's shelf. Closed by default; toggled by `z` or the ledger toggle; remembered (`prefs.overview`). It is in the flow directly under the front (full width, above the piles), never sticky, never a side column. It shows the same set of sessions as the rows: the text and family filters apply.

**Model** (`overviewModel(board, visible, prefs)`, pure):

- Shelves = projects (`card.project.key`). A shelf holds marks for its cards in Needs you, Stuck?, Unread, Working and Recent, and a **number** for To archive (sessions, counting routine `runIds`). Cleanup is never drawn as marks.
- Mark order inside a shelf: pile order (Needs you, Stuck?, Unread, Working, Recent), then the rows' order. At most `OVERVIEW_SHELF_MAX` (60) marks per shelf, then `overview.more`. The cut always falls on Recent first because of the order.
- **Live** shelves have at least one Needs you, Stuck?, Unread or Working mark. Shelf order: shelves with Needs you first, then Stuck?, Unread, Working; ties by the newest activity; "No project folder" last within its rank.
- **Quiet** shelves (only Recent and/or To archive) fold into one line: `overview.quiet` + `overview.quietCounts` + [`overview.quietShow`] / [`overview.quietHide`] (`aria-expanded`, remembered in `prefs.overviewQuiet`). Unfolded, quiet shelves follow the live ones, newest first.
- Nothing visible → `overview.empty`.

**Marks** (shape tells the state; only Needs you is coloured; every mark differs from the others by shape, so the view reads in greyscale):

| pile | mark (10px glyph in a 14px button) |
|---|---|
| Needs you | filled **square**, `--color-accent` |
| Stuck? | filled **triangle**, `--color-ink` |
| Unread | filled **circle**, `--color-ink` |
| Working | **ring** (1.5px border), `--color-ink-2` |
| Recent | short horizontal **bar** (10×2px), `--color-muted` |

- The cursor's session gets a 2px ink outline on its mark. Focus uses the normal focus ring.
- No barcode, no dense fields: marks wrap with a 4px gap; cleanup is a number; quiet projects fold.
- Forced colors (Windows contrast themes): the marks keep their shapes in system colours (`Highlight` for Needs you, `CanvasText`, `GrayText` for Recent) with `forced-color-adjust: none`; so do the row's next square and cursor triangle.
- Re-rendering: the Overview is rebuilt only when `overviewSig` changes (language, shelves, marks with their piles and titles, the quiet fold). Otherwise the marks' labels (with times), the cursor outline and the roving tab stop are set in place, so a poll never re-announces or rebuilds the focused mark. When a rebuild removes the focused mark, focus goes to the same mark with `preventScroll: true`.

**DOM and ARIA**: `section#overview` (aria-labelledby its `h2` `overview.title`), a legend line (five sample marks, `aria-hidden`, each followed by the pile name; then `overview.key.cleanup`; separated by space), the hint `overview.hint`, then one `div[role=group]` per shelf with `aria-label` `overview.shelfAria` (parts `overview.part` joined by `sep.list`, plus `overview.cleanup`). A shelf row: project label (12rem column from 40rem; above the marks below 40rem) · marks · `overview.cleanup` (muted, end). Each mark is a `button` with `aria-label` `overview.mark` and the same text as `title` (native tooltip).

**Keys and focus**: the whole Overview is one tab stop (roving `tabindex`). ←/→ (and j/k) previous/next mark in reading order across shelves; ↑/↓ the mark at the same index on the previous/next shelf (clamped); Home/End first/last. Enter, Space or a click → `jumpTo(id)`: open the pile if collapsed (Recent, To archive), open the project group and expand the list's preview if the row is hidden behind [`list.more`], put the cursor on the row, scroll it into view (`block: 'center'`, `auto` under reduced motion) and focus its title button. `z` opens the Overview and focuses the cursor's mark (or the first mark), scrolling it into view; `z` or Esc inside it closes it and returns focus to the cursor row (or the toggle). `overviewKey(ev, keysOn)` (pure) ignores IME composition, modifiers and a held `z`, and with single-key shortcuts off it ignores `j`, `k` and `z` (arrows, Home, End, Enter, Space and Esc keep working).

Opening and closing use the disclose primitive. Nothing else moves.

## 11. Filtering

- Client-side only. `matches(card, q, t)`: case-insensitive substring over title, `projectLabel(t, project)`, body and `reasonLine(t, card)` in the current language.
- Applies to every pile, the ledger counts and the Overview. Collapsed piles show `bucket.match` in the head. While filtering: previews and pages are off (every match shows), reason groups and sub-groups that contain matches open; piles with 0 matches are hidden.
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
| `j` / `↓`, `k` / `↑` | move the cursor to the next / previous visible row in reading (DOM) order across piles, and focus its title button (`preventScroll`, then scroll into view inside the scroll padding) |
| `Enter`, `o` | open the cursor row's session: `openSession(id)` clicks a temporary `<a href="claude://…">` (the same as the row's Open link; To archive rows too). No cursor → the lede's session. Disabled IDs do nothing. On a focused row title, Enter opens instead of toggling (`preventDefault`); on any other focused control Enter keeps its native meaning |
| `Space` | toggle the cursor row's detail (on a focused title, native) |
| `x` | pick / unpick the cursor row when it is a To archive row (announce `live.picked` / `live.unpicked`); otherwise nothing |
| `a` | pick every suggested row (adds only); announce `live.selectAll`. Does nothing under `formatSuspect` |
| `c` | copy the next chunk (§12); with nothing picked, announce `live.nothingPicked`. After a fallback copy (textarea or dialog), focus returns to the focused control or the cursor row's title |
| `/` | focus the filter |
| `?` | open the help dialog |
| `1`–`6` | jump to Needs you, Stuck?, Unread, Working, Recent, To archive: open it if collapsed, cursor and focus on its first row; an empty pile announces `bucket.none` |
| `z` | open or close the Overview (§10) |
| `Esc` | in order, the first that applies: close the open dialog (native) → in the filter: clear it, or blur when already empty → in the Overview: close it, focus back to the cursor row → collapse the cursor row's open detail → clear the family filter → clear the text filter. **Never** clears a selection or a batch |

- **IME-safe and polite**: ignore when `ev.isComposing` or `ev.keyCode === 229`; ignore when Ctrl, Meta or Alt is held; Shift is ignored only on named keys (Enter, Space, arrows): single-character keys match `ev.key`, the character the layout produced, so `/` and `1`–`6` work on layouts that need Shift for them (German, French) and Shift+J is simply not a key; ignore when the target is a text-entry control (`input` other than checkbox and radio, `textarea`, `select`, `[contenteditable]`) or inside an open `dialog` (Esc in the filter is the exception above); a focused checkbox counts as a control (Space and Enter stay native, the other keys work, and focusing a To archive row's checkbox puts the cursor on that row); ignore repeats for `x`, `a`, `c`, `z`.
- **WCAG 2.1.4 off switch**: the help dialog has a checkbox `help.off` (+ `help.offNote`), remembered in `prefs.keys` (default on). Off: every single-character shortcut (j k o x a c / ? 1–6 z) is ignored, inside the Overview too; Enter, Space, Esc, arrows in the Overview and Tab keep working; the footer key hints hide, and so do the single-character hints inside controls (`kbd.hk`: `/` in the filter, `z` on the Overview toggle, `c` on Copy instruction) via `:root.keys-off`.
- **Hints inside controls** are `aria-hidden` so they stay out of the accessible name; the control carries `aria-keyshortcuts` instead (the lede's Open: `Enter`; the Overview toggle: `z` while shortcuts are on; Clear filter: `Escape`).
- Keys mirror Claude Code's agent view where they overlap (j/k, Enter, Space, x, /, ?).

## 15. Focus and re-rendering

- Rendering is keyed by session ID (`reconcile`). A node is rebuilt only when its signature changes: `sig = lang + '|' + JSON.stringify(card) + '|' + flags` (flags: next, cursor, new, picked, copied, open). Switching language changes every signature, so every node is rebuilt once.
- The cursor is `{id, pile, index}` (`state.cursor`); `index` is the position among the rows that pile shows. After each board, `cursorAfter(cursor, lists)` (pure): the same ID in the same pile → keep; the ID moved to another pile → keep the **same pile and index** (the next row) and announce once `live.moved`; the pile emptied → the first row of the next non-empty pile; nothing left → no cursor. `setBoard` uses the whole board for `live.moved`; after the board is drawn, `render()` settles the cursor again with the **visible** rows (`listsFromRows(visibleRows())`), so it never lands on a row the filter, a preview cut or a closed group hides.
- A poll never moves DOM focus, except when the focused element was removed or hidden (inside `[hidden]` or `[inert]`, as when the selection bar hides after Clear selection or Close): then focus goes to the same control rebuilt, else the title button of the row now at the cursor (`focus({preventScroll: true})`), else the head of the pile it was in (for the selection bar: the To archive toggle; a plain pile head gets `tabindex=-1`). The filter input never loses focus or text to a re-render.
- Open details, expanded lists, open groups and sub-groups, picks, the copied set, the batch and the Overview survive re-renders (kept by ID or key). `overflow-anchor` keeps the visible rows still when rows are added above.
- `contentLang(text)` (pure): `'ja'` when the text contains kana or kanji (`/[぀-ヿ㐀-鿿]/`), else `'en'`. Content nodes (titles, bodies, quotes, questions) get `lang` when it differs from the UI language, so quotes and line breaking follow the content.
- The live region `#live` (polite) speaks only on: a row moving pile (the cursor's row), select-all, `x` (`live.picked` / `live.unpicked`), a copy (`live.copied`, and `live.copiedId` / `live.copiedLink` for the detail's copy buttons), a pile jump to an empty pile, a batch finishing (`sel.done`), the filter's match count after typing pauses (§11), and a change in the kind of failure (§7). Never on an ordinary poll.

## 16. Updates and time

- `GET /api/board` every `POLL_MS` (5 s) with `If-None-Match`; timeout `FETCH_TIMEOUT_MS` (4 s), the first fetch `FIRST_FETCH_TIMEOUT_MS` (20 s). While `document.hidden`, stop (or `HIDDEN_POLL_MS` when notifications are on); fetch once on return.
- 304 → only the dateline is rewritten (`renderPulse()`); a full `render()` happens only to clear a failure notice. 200 → `setBoard`, `pruneSelection`, `cursorAfter`, `render()` (which settles the cursor on visible rows), `arrivals`; the ETag is taken only after the board is drawn. Only the fetch is in the fetch's `try`: an exception while drawing is the draw-failed state (§5), not offline.
- `serverNow − Date.now()` is kept as a clock offset; every time text uses server time.
- A **minute tick** (aligned to the next minute) calls `renderTimes()`: row time cells, lede times, the dateline, the quiet hints. When a `badge.new` mark has expired, `pruneNew()` drops it and `render()` runs first (rows whose signature changed are rebuilt), and the time cells and hints are still rewritten afterwards. Nothing updates every second; the only seconds shown are in the stale dateline, updated on the 5 s poll.
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

**Help dialog** (`<dialog id="help">`, `showModal()`, `::backdrop` `--color-scrim`, radius `--radius-dialog`): title `help.title`, the key table (`help.k.*`, each with `kbd`), the legend (`intro.*`), the Overview mark key, the off switch (`help.off`), [`help.close`]. It opens at the top: focus goes to the title (`tabindex=-1`, `preventScroll`) and the dialog's scroll is reset; Tab reaches the off switch and Close. Esc and the close button return focus to the "?" button.

**Footer** (`--rule-ink` above; two columns from 60rem):
- left: `foot.trust` (bold ink) · key hints `kbd` + `foot.keys.*`, nowrap each (hidden when shortcuts are off) · the notify button + `foot.notifyNote` (or `foot.notifyBlocked`, §13).
- right: `foot.archived` (when > 0) · `foot.demo` (when `stats.demo`) · `foot.noDir` (when `stats.transcriptsDirMissing`) and `foot.badFormat` (when `unknownTurnRecent / recentWithTranscript > 0.5`), both visible in ink · `details` `foot.diag` holding `foot.bad` (stats.bad > 0), `foot.missing` + `foot.missingWhy` (transcriptsMissingRecent > 0), else `foot.allGood` · `foot.disclaimer` (muted).
- The footer's signature holds only what it shows (not `scanMs` or other stats), and a rebuild keeps `foot.diag` open when it was open.

## 19. Copy deck

Rules: placeholders are `{name}`; the plural count is always `{n}`; an English cell written `a \| b` means `{one: a, other: b}`; `␣` marks a meaningful space. `{days}` comes from `RECENT_MS`, `{days}` in idle_30d from `IDLE_SAFE_MS`, `{min}`/`{limit}` from `QUIET_MS`. A key keeps its name while its meaning is unchanged. This table is the source of truth for both languages, and the tests are baselined against it. Both dictionaries must have the same keys and the same placeholders per key (parity test).

### 19.1 App, masthead, dates

| key | en | ja |
|---|---|---|
| `app.name` | Pigeonholes | Pigeonholes |
| `app.tabTitle` | ({n}) {pile} — {name} | ({n}) {pile} — {name} |
| `app.tabOffline` | {title} (offline) | {title} (オフライン) |
| `mast.home` | Pigeonholes, back to top | Pigeonholes 先頭へ |
| `mast.trust` | Read-only. Nothing leaves this computer. | 読み取り専用。このパソコンの外へは何も送りません。 |
| `mast.demo` | Demo data | デモデータ |
| `mast.help` | Keyboard keys | キー一覧 |
| `date.asOf` | {wd} {d} {mon}, as of {hm} | {mon} {d} 日 ({wd}) {hm} 時点 |
| `date.stale` | data from {ago} | {ago}の内容 |
| `date.today` | today {hm} | 今日 {hm} |
| `date.wd.0` … `date.wd.6` | Sun, Mon, Tue, Wed, Thu, Fri, Sat | 日, 月, 火, 水, 木, 金, 土 |
| `date.mon.0` … `date.mon.11` | Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec | 1 月, 2 月, 3 月, 4 月, 5 月, 6 月, 7 月, 8 月, 9 月, 10 月, 11 月, 12 月 |
| `filter.label` | Filter by title, project or summary | タイトル・プロジェクト・要約で絞り込み |
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
| `ledger.overviewOpen` | Overview | 全体を見る |
| `ledger.overviewClose` | Close overview | 全体を閉じる |
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
| `detail.summary` | Claude's summary | Claude の要約 |
| `detail.error` | Full error | エラー全文 |
| `detail.branch` | Branch | ブランチ |
| `detail.worktree` | Worktree | 作業ツリー |
| `detail.folder` | Folder | フォルダ |
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
| `nomatch.query.text` | Searched titles, projects and summaries. | タイトル・プロジェクト・要約を探しました。 |
| `nomatch.family` | Nothing in this family matches. | この親子には該当するものがありません。 |
| `nomatch.clear` | Clear filter | 絞り込みを消す |

### 19.9 Overview

| key | en | ja |
|---|---|---|
| `overview.title` | Overview | 全体 |
| `overview.key.cleanup` | number = sessions to archive | 数字 = 片付けの件数 |
| `overview.hint` | Select a mark to jump to its row. | 印を押すと、その行へ移ります。 |
| `overview.mark` | {pile}: {title}, {time} | {pile}: {title}、{time} |
| `overview.shelfAria` | {project}: {list} | {project}: {list} |
| `overview.part` | {pile} {n} | {pile} {n} 件 |
| `overview.cleanup` | To archive {n} | 片付け {n} |
| `overview.more` | +{n} more | ほか {n} 件 |
| `overview.quiet` | {n} project with nothing to do \| {n} projects with nothing to do | やることのないプロジェクト {n} 件 |
| `overview.quietCounts` | {recent} recent, {cleanup} to archive | 最近 {recent} 件、片付け {cleanup} 件 |
| `overview.quietShow` | Show them | 広げる |
| `overview.quietHide` | Fold them | たたむ |
| `overview.empty` | Nothing to show. | 表示するものはありません。 |

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
| `cleanup.why` | Archiving deletes nothing: you can restore any session in the Claude app. This board changes nothing itself; it only writes the instruction for Claude. | アーカイブしても消えません。Claude アプリからいつでも戻せます。このボードは何も書き換えず、Claude への指示文を用意するだけです。 |
| `cleanup.selectAll` | Select all {n} suggested | おすすめ {n} 件をまとめて選ぶ |
| `cleanup.tally` | {sel} / {n} | {sel} / {n} |
| `cleanup.def` | Suggested means safe to archive. Left out: open PRs, pinned, marked to keep, an unread last report, or a child session still in use. | おすすめ = 片付けても困らないと判断できたもの。PR が開いている・ピン留め・残す印・未読の報告・使用中の子があるものは外しています。 |
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
| `help.k.overview` | Open or close the overview | 全体を開く / 閉じる |
| `help.k.help` | This list | このキー一覧 |
| `help.k.esc` | Close, in order: dialog, filter, overview, details | 閉じる (キー一覧 → 絞り込み → 全体 → 詳しく の順) |
| `help.marks` | Overview marks | 全体の印 |
| `help.off` | Turn off single-key shortcuts | 一文字キーを使わない |
| `help.offNote` | Enter, Space, Esc and Tab keep working. | Enter・Space・Esc・Tab はそのまま使えます。 |
| `foot.trust` | Read-only. Nothing leaves this computer. | 読み取り専用。このパソコンの外へは何も送りません。 |
| `foot.keys.move` | move | 移動 |
| `foot.keys.open` | open | 開く |
| `foot.keys.peek` | details | 詳しく |
| `foot.keys.pick` | pick | 選ぶ |
| `foot.keys.filter` | filter | 絞り込み |
| `foot.keys.overview` | overview | 全体 |
| `foot.keys.more` | more keys | ほかのキー |
| `foot.notifyOn` | Turn on notifications | 通知をオンにする |
| `foot.notifyOff` | Turn off notifications | 通知をオフにする |
| `foot.notifyNote` | Only for Needs you and Stuck?. The Claude app already tells you when a session finishes. | 「返事待ち」と「止まったかも」だけ。終わった知らせは Claude アプリが出します。 |
| `foot.notifyBlocked` | Notifications are blocked for this page in this browser. | このブラウザでは、このページの通知が止められています。 |
| `foot.archived` | {n} archived session not shown. \| {n} archived sessions not shown. | アーカイブ済みの {n} 件は表示していません。 |
| `foot.demo` | Showing demo data, not your sessions. | デモデータを表示しています。あなたのセッションではありません。 |
| `foot.noDir` | Transcript folder not found, so “Working” and “Stuck?” can't be detected. | 会話ログのフォルダが見つかりません。「作業中」「止まったかも」は判定できません。 |
| `foot.badFormat` | Can't read the transcript format. “Working” and “Stuck?” may be missing. | 会話ログの形式を読めていません。「作業中」「止まったかも」が出ていない可能性があります。 |
| `foot.diag` | Reading status | 読み込みの状態 |
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
| detail panel | `detail.{statusDetail, branch, worktreeName, cwd, completedTurns, error, prsMore}`, `prs[].{num,repo,state,url}`, `createdAt`, `routine.{completed,stalled,runs}`, `family.*` |
| family tree, family filter | `families[rootId].{title, memberIds}`, every card's `family.parentId`, `createdAt`, `bucket`, `routine.runIds` |
| Overview | every card's `id`, `bucket`, `title`, `since`, `timeKind`, `startedAt`, `project.{key,label}`, `lastActivityAt`; cleanup cards' `project.key` and `routine.runIds` for the per-shelf number |
| notices, footer | `stats.formatSuspect` (null \| 'no_timestamps' \| 'no_session_files'), `stats.demo`, `stats.archived`, `stats.bad`, `stats.transcriptsMissingRecent`, `stats.transcriptsDirMissing`, `stats.unknownTurnRecent`, `stats.recentWithTranscript` |
| batch progress, selection pruning | the set of every card ID plus every `routine.runIds` member (present IDs), and the cleanup subset |

New in v2 for the UI: `reasonParams` (replaces `reasonText`), `cleanup.note` as a code, `project.label: null`, `startedAt`, `stats.formatSuspect`, `stats.demo`. HTTP 500 carries `{"error":"board_failed"}` (the UI shows its own words).

## 21. Tests and acceptance

Unit tests (`node --test`, synthetic data, both languages):
- `format`: every `reasonLine` case in en and ja; `timeText` for every kind and its `_now` form; `durationText` short and long, n = 0, 1, 2; `parseResetTime` (`resets 1:50pm`, `resets at 13:00`, `resets 9am`, unparsable → null); `contentLang`; `tabTitle` (needs, stuck only, none, offline); `dateline`; `matches` finds a Stuck? card by its rendered reason and a no-folder card by `project.other`; `archiveInstruction` is 3 lines + one ID per line in both languages.
- `ui-state`: `planCopy`, `commitCopy`, `pruneSelection`, `reselectIds`, `batchProgress` (0, partial, done, stale at 2 min), `checkState`, `nextUp` (needs > stuck > unread, oldest first), `cursorAfter` (same pile, moved pile, emptied pile, and on visible rows via `listsFromRows`), `stalePrefKeys`, `stepOf`.
- `cleanup`: `applyPick` with the filtered model touches only visible rows; `hiddenPicks` counts closed and filtered picks.
- `overview`: shelf order, the 60-mark cap and `+N`, quiet folding, cleanup counts including `runIds`, filtered sets; `overviewSig` ignores times and the cursor; `overviewKey` honours the off switch.
- `i18n`: same keys and the same placeholder set per key in `EN` and `JA` (plural forms included); no empty strings; plural objects only in `EN`; `detectLang` (`?lang`, saved, `navigator.languages` with `ja-JP` first, `fr` → `en`).
- `keys`: `keyAction` ignores IME composition, modifiers, inputs and dialogs; the off switch keeps Enter/Esc; Shift with a printable key keeps the character (`/`, digits).
- `rows`: `detailStamp` ignores unrelated cards and changes with the family tree, the language and the day. `state`: `pruneNew`, `reselectLeft`.
- `favicon`: `faviconKind`; `faviconHref` contains the accent only for `needs`.
- `notify`: `arrivals` is empty on the first board and ignores Unread.

Acceptance (screenshots with the demo server on a free port in 18950–18999, `?lang=en` and `?lang=ja`, light and dark):
- 1280, 768, 400 and 320 px: no horizontal scroll; no control label wraps to two lines (a link that holds a session title, such as the parent link, may wrap, since titles never truncate; a sub-group toggle puts its time on its own line below 24rem by design); at 400×800 the first Needs-you row starts at or above 520px, also with a fresh profile (first run).
- Every state in §5 and every notice in §7 rendered once (the demo plus fault injection in tests).
- A synthetic 300-session board: the Overview stays readable (no solid blocks), To archive scrolls smoothly, the selection bar never covers a focused row.
- Keyboard only: j/k through every pile, Enter opens, Space peeks, x/a/c through a full copy, z into the Overview and back, Esc never drops the selection.
