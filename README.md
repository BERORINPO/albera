# Pigeonholes

A read-only page on your own computer that sorts every session in the Code tab of the Claude desktop app (Claude Code) into six piles: needs your answer, may be stuck, finished but unread, working, recent, and ready to archive. Chats from the app's other tabs are not shown.

[日本語](README.ja.md)

> Unofficial community tool. Not affiliated with, endorsed by, or supported by Anthropic. Claude is a trademark of Anthropic.

![Pigeonholes with demo data: the session to answer first at the top, a count for each pile on the right, then the piles](docs/screenshot.png)

Demo data. Also: [dark theme](docs/screenshot-dark.png) · [400 px wide](docs/screenshot-narrow.png) · [Japanese](docs/screenshot-ja.png)

- **Read-only.** It reads the app's session files and never writes to them. It listens on 127.0.0.1 only and makes no network requests of its own (see [What it reads](#what-it-reads) for folders on network drives).
- **Zero dependencies.** Node.js 22 or newer. No build step.
- **English and Japanese.** The page follows your browser language; the terminal follows your system language.

## Quick start

You need Node.js 22 or newer and the Claude desktop app, with at least one session in its Code tab.

```sh
npx pigeonholes
```

From a clone:

```sh
git clone https://github.com/BERORINPO/pigeonholes.git
cd pigeonholes
npm start                       # same as: node src/entry/server.mjs
```

npm needs `--` before flags for the script: `npm start -- --port 8798`, `npm run demo -- --lang en`. Without it, npm takes the flag for itself. `node src/entry/server.mjs --port 8798` works without it.

When the terminal prints `Pigeonholes: http://127.0.0.1:8797 (read-only)`, open that address in a browser. The first scan takes a few seconds. Stop it with Ctrl+C. If it prints `Already running: open http://127.0.0.1:8797`, a board of the same kind is already up; open the address. If the board on that port is the demo and you asked for your sessions (or the other way round), it says so and prints a command for another port instead.

To try it without reading your sessions, add `--demo` (synthetic data):

```sh
npx pigeonholes --demo          # from a clone: npm run demo
```

Tip: the Claude desktop app has a built-in browser pane. Open the address there and the board sits next to your conversation. It works down to about 400 px wide. In that pane, desktop notifications are not available, and **Open** may be blocked; then use **Copy link** in the details, or open the board in your usual browser.

## What it reads

Everything is opened read-only. Nothing is sent anywhere, and it does not read the app's settings, cookies or credentials.

| What | Windows | macOS | Linux |
|---|---|---|---|
| Session list (`<account>/<org>/local_*.json`, `archived-sessions.idx`) | `%APPDATA%\Claude\claude-code-sessions`, then the Microsoft Store location `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-sessions` | `~/Library/Application Support/Claude/claude-code-sessions` | `$XDG_CONFIG_HOME/Claude/claude-code-sessions`, then `~/.config/Claude/claude-code-sessions` |
| Transcripts (`<id>.jsonl`) | `%USERPROFILE%\.claude\projects` | `~/.claude/projects` | `~/.claude/projects` |

- The first session folder that exists is used. `--sessions-dir` replaces the search.
- Transcripts: `$CLAUDE_CONFIG_DIR/projects` is used instead when `CLAUDE_CONFIG_DIR` is set. Only the end of each transcript is read, and only for sessions active in the last 7 days: the last 200 KB, or once the last 2 MB when those 200 KB hold no usable line (for example one very long tool output). For background agents it checks file times under `<id>/subagents/` and does not open those files.
- The folder each session ran in (not for archived sessions): only whether a `.git` exists there or above it, and the names of its direct subfolders. This names the project. Network paths (`\\server\share`, `//server/share`) are skipped. A folder on a mapped network drive looks like any other path, so the operating system may reach that share when the board checks it; each check gives up after half a second.
- Session fields it does not use (for example MCP server settings) are dropped right after reading and never reach the page.
- The page remembers your choices in this browser's storage (language, shortcuts and notifications switches, which piles and project groups you opened). The project groups are remembered by their folder names; entries for projects no longer on the board are removed.

## The six piles

| Pile | Meaning | What to do |
|---|---|---|
| Needs you | Claude asked a question, wants a plan approved, or says it needs you | Open and answer. Longest wait first |
| Stuck? | An error, a usage limit, a failed start, or 15 minutes without progress | Open and check. Restart it if nothing moves |
| Unread | Finished, and you have not opened the result yet | Open and read |
| Working | Running now | Wait |
| Recent | Read within the last 7 days | Nothing |
| To archive | Idle for 7 days or more, older runs of a scheduled task, retried attempts, sessions whose PRs are all merged or closed | Pick, copy the instruction, paste it into Claude |

The top line names the one session to look at first. The counts list (on the right on wide screens, under the top line on narrow ones) counts every pile. **Open** opens the session in the Claude app. Click a title for details: full summary, folder, branch, PRs, related sessions, and buttons to copy the ID or link. The page refreshes every 5 seconds while it is visible. Desktop notifications for Needs you and Stuck? are off until you turn them on in the footer.

## Keys

| Key | Action |
|---|---|
| `j` / `k` (or `↓` / `↑`) | Next / previous row |
| `Enter` or `o` | Open the session in the Claude app |
| `Space` | Show or hide details |
| `x` | Pick or unpick a row in To archive |
| `a` | Pick all suggested rows |
| `c` | Copy the archive instruction (next 50) |
| `/` | Filter |
| `1`–`6` | Jump to a pile |
| `z` | Overview: every session as a mark, grouped by project |
| `?` | All keys |
| `Esc` | Close, in order: dialog, filter, overview, details |

Single-letter keys can be turned off in the `?` dialog.

## Archiving old sessions

The board never changes anything. Instead it writes an instruction for Claude.

1. In **To archive**, tick **Select all N suggested**, or pick rows one by one.
2. Press **Copy instruction** in the bar at the bottom. It copies 50 sessions at a time: three lines of instruction, then one session ID per line (no titles).
3. Paste it into a session in the Claude desktop app and send it. Claude archives those sessions and replies with how many it archived and skipped. If it asks for permission, allow it in that chat.
4. Archived sessions leave the board on the next refresh. The bar counts how many are done.

Why only an instruction: the app owns these files and rewrites them all the time. Writing to them from outside could race with the app and corrupt them. Archiving through Claude uses the app's own way of doing it, and you see and approve every step.

Archiving deletes nothing; you can restore any session in the Claude app. The suggestions leave out sessions with an open PR, a pin, a "keep" mark, an unread last report, or a child session still in use. Those rows can still be picked by hand. If the app's file format looks changed (many sessions without dates), suggestions turn off and a notice explains why.

## Compatibility

- **Undocumented files.** Pigeonholes reads the desktop app's local files, which are not a public API. An app update can change them and break the board, or put sessions in the wrong pile. Please open an issue with your app version.
- **Open link.** Open uses the app's `claude://` link. It is best-effort: some browsers and embedded panes block it. Use **Copy link** or **Copy ID** in the details instead.
- **Platforms.** Developed on Windows (including the Microsoft Store install). The macOS folder is the app's standard location. The Linux path is untested; if your folder is elsewhere, please report it. The test suite runs on Windows, macOS and Linux with synthetic data.
- **Remote sessions.** Sessions that ran in the cloud or on another machine have no transcript on this computer, so Working and Stuck? cannot be detected for them. The footer says how many.

## Configuration

Flags win over environment variables. Both `--flag value` and `--flag=value` work.

| Flag | Environment variable | Default |
|---|---|---|
| `--port <n>` | `PIGEONHOLES_PORT` | `8797` (1024–65535) |
| `--lang en\|ja` | `PIGEONHOLES_LANG` | your system language. Sets the terminal messages and the demo content |
| `--demo` | `PIGEONHOLES_DEMO=1` | off |
| `--sessions-dir <path>` | `PIGEONHOLES_SESSIONS_DIR` | searched (see [What it reads](#what-it-reads)) |
| `--projects-dir <path>` | `PIGEONHOLES_PROJECTS_DIR` | `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects` |
| — | `PIGEONHOLES_ROOTS` | your home folder. Absolute paths separated by `;` (or `:` on macOS and Linux). A session in `<root>/<name>/...` outside any git repository is grouped under `<name>` |
| `--help`, `--version` | — | — |

Projects are named after the git repository a session runs in. Worktrees under `.claude/worktrees/` count as their repository.

The page address takes `?lang=en` or `?lang=ja`, and `?theme=light` or `?theme=dark`. The language button in the header remembers your choice in this browser.

## Troubleshooting

| You see | Do this |
|---|---|
| `Port 8797 is used by another app` | Start on another port. The message prints a command you can paste (for example `npx pigeonholes --port 8798`); it keeps the other flags you used, such as `--demo` |
| `Port 8797 has the demo board, not your sessions` (or the other way round) | Stop the other board with Ctrl+C in its terminal, or paste the printed command for another port |
| `Can't find the Claude desktop app's session folder` | Start a session once in the Code tab of the Claude desktop app, or pass `--sessions-dir <path>`. Chats in the app's other tabs do not create this folder. The message lists every folder it tried |
| The page says it can't reach the server | The terminal was closed. Start it again; the page reconnects by itself |
| **Open** does nothing | Your browser blocked the `claude://` link. Use **Copy link** or **Copy ID** in the details, or open the board in another browser |
| The footer says notifications are blocked | This browser does not allow notifications for the page (Claude's built-in pane is one). Open the board in your usual browser to use them |
| **Copy instruction** shows a text box | Automatic copy is not available here. Press Ctrl+C (Cmd+C on macOS) in the box |
| A working session shows under **Stuck?** | It is waiting for a permission prompt or running a step that takes over 15 minutes. Open it to see |
| A session stays **Unread** after you read it here | Open it once in the Claude app. The board cannot mark it read |
| The footer says the transcript folder was not found | Working and Stuck? need transcripts. Pass `--projects-dir <path>` or set `CLAUDE_CONFIG_DIR` |
| A notice says the app's file format may have changed | Suggestions are off for safety. Please open an issue with your app version |

## Development

```sh
npm test          # unit and integration tests (node:test, synthetic data only)
npm run arch      # dependency direction, forbidden APIs, words only in the dictionaries
npm run smoke     # reads this computer's real sessions read-only on a random port; prints counts only
npm run demo      # the board with synthetic data
```

Specs: [spec/board.md](spec/board.md) (data and rules, in Japanese), [spec/ui.md](spec/ui.md) (screen), [spec/design.md](spec/design.md) (look), [spec/architecture.md](spec/architecture.md) (layers and decisions, in Japanese). Test names and many code comments are in Japanese too. Security reports: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
