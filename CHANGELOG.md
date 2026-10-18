# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/); while the version starts with 0, a minor release may change behaviour.

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
- Read-only by design: listens on 127.0.0.1 only, checks the Host header, answers GET only, never writes files and makes no network requests of its own (network paths in session folders are skipped). Zero runtime dependencies.
