# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/); while the version starts with 0, a minor release may change behaviour.

## 0.2.0 - 2026-10-19

### Added

- **Canvas view** (`v`, or `?view=canvas`): one sheet per project, one slip per session that needs looking at, on a desk you can pan and zoom. Placement is a fixed rule, not AI: sheets go by urgency (the longest wait for you top left), Needs you and Stuck? come first on each sheet (the list's order) and a child names its parent, Recent and To archive are one line at the foot of the sheet, and projects with only sessions to archive share one block under the sheets. Rows are as tall as what they hold. Three zoom levels (far: marks, and how many sessions need you per project; mid: title, time, what a working or stuck session is doing, and the context when it matters; near: also branch, worktree, PR, the parent, the question or full doing line, Open and Hand off); a narrow window opens at near and zooms out straight to far. Sheets can be dragged, moved with buttons or Shift + arrow keys, and laid out again with Rearrange; their places are kept in the browser. A bar at the bottom holds the legend, zoom, Fit all, and the details and hand-off guide of the chosen session. Works at 400 px wide and from the keyboard alone.
- **Doing what**: Working rows say what the session is doing, from the last tool it used (for example "Editing board.mjs", "Running tests (npm test)", "2 helpers at work"); Stuck? rows say "As of 3 hours ago: …". Where Claude wrote its own short words (the plan step in progress, the description of its last shell command), they are shown after cleaning: no paths beyond a file name, no addresses beyond a host, no IDs, e-mail addresses, keys or password-like text, at most 40 characters.
- **Context gauge**: each recent session shows how full its context is (`context 82%`, `~` when the window size is a guess), with three levels set against the auto-summary point: notice, "time to hand off" (about 80% of a 1M window) and "summarizes itself soon" (about 90%). Words and weight only; the canvas adds a small tick. "Summarized N min ago" after a summary. **Time to hand off: N** walks through the sessions that can be handed off now.
- **Hand-off**: **Hand off** (or `h`) on an Unread or Recent session opens a guide; **Copy and open** copies an instruction and opens that session in the Claude app. Pasted there, it asks Claude to stop at a safe point, write a brief, say where the new session will work and whether archiving would take the new one along, and ask once before starting a new session with a fresh context. The board itself sends, approves and starts nothing. No button on Working, Needs you or sessions at the usage limit (pasting would interrupt or answer them). A Stuck? session too full to answer gets **Copy for a new session** instead.
- The filter also finds sessions by what they are doing and by the context words (for example "hand off").
- Footer notices when token counts or tool use can no longer be read from the transcripts. `npm run smoke` prints aggregate counts for the new fields.

### Changed

- `z` in the list now switches to the canvas and fits everything.
- The details show what the session is doing, its plan step and its context with the token counts.
- The notes at the top of To archive are shorter.
- Reads a little more from the end of recent transcripts: token counts, auto-summary markers, tool names, file names (not folders), a command's program name and subcommand, web hosts, connector names, the plan step and Claude's command descriptions. Tool results are still never kept. The last 2 MB is read once also when the last 200 KB hold no token count.
- Reads the session's model name and how many times the app recorded it running out of context. The model name is used only to guess the context window and never reaches the page; the count only decides whether a stuck session gets **Copy for a new session**.
- Background agents: also counts the helper transcript files written recently (file times only; the files are still never opened).
- `/api/board` (still version 2) gains optional `activity` and `context` fields and `detail.contextExceeded` on cards, and `contextSeen`, `activitySeen`, `contextSuspect` in `stats`.
- The browser also remembers the view, the canvas sheet places (by project folder name, 7 days after a project leaves) and which sessions a hand-off was copied for (24 hours).

### Removed

- The Overview (`z`): the canvas zoomed out replaces it. Its saved switches are dropped from browser storage.

## 0.1.0 - 2026-10-19

First public release.

### Added

- One local page that sorts every session in the Code tab of the Claude desktop app into six piles: Needs you, Stuck?, Unread, Working, Recent and To archive.
- A top line that names the one session to look at first, and a ledger with the count of each pile.
- Details for each session: summary, folder, branch, PRs, related sessions, and buttons to copy the ID or link. **Open** opens the session in the Claude app through its `claude://` link.
- Overview (`z`): every session as a mark, grouped by project.
- Archiving through Claude: pick sessions (or all suggested ones), copy an instruction with up to 50 session IDs, paste it into Claude, and watch the count of archived sessions. Suggestions leave out open PRs, pins, "keep" marks, unread reports and parents of active child sessions, and turn off when the app's file format looks changed.
- Keyboard shortcuts, with a switch to turn off single-letter keys.
- Opt-in desktop notifications for Needs you and Stuck?, and a favicon and tab title that show when something needs you or is stuck.
- English and Japanese for the page and the terminal; light and dark themes; works down to about 400 px wide.
- `--demo` mode with synthetic data in English or Japanese.
- Session folder search for Windows (including the Microsoft Store install), macOS and Linux, and options `--port`, `--lang`, `--sessions-dir`, `--projects-dir`, `--help` and `--version`, with matching `PIGEONHOLES_*` environment variables.
- Read-only by design: listens on 127.0.0.1 only, checks the Host header, answers GET only, never writes files and makes no requests to other machines (its one request goes to its own port on 127.0.0.1 when that port is busy; network paths in session folders are skipped). Zero runtime dependencies.
