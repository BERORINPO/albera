# Security

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting). Do not open a public issue for a security problem.

- Describe the problem and how to reproduce it. A reproduction with `--demo` (synthetic data) is ideal.
- Do not include real session titles, session IDs, folder paths or transcript text.
- This is a volunteer project. Reports are answered on a best-effort basis, and fixes go into the latest release only.

## Threat model

Pigeonholes is a local, read-only viewer. It shows what the Claude desktop app has already written to files in your user account.

What it does to keep that data on your computer:

- **Listens on 127.0.0.1 only.** Other machines on your network cannot connect.
- **Host allowlist.** Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` get 403. This blocks DNS rebinding, where a web page tries to reach a local port through its own domain name.
- **GET only.** Every other method gets 405. There is no endpoint that changes anything.
- **No CORS headers.** Other websites open in your browser cannot read the board's responses.
- **Strict headers.** `Content-Security-Policy: default-src 'self'` with `script-src`, `style-src` and `connect-src` limited to `'self'`, `frame-ancestors 'none'`, `form-action 'none'` and `base-uri 'none'`; plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- **Fixed file table.** Static files are listed once at startup. Request paths are never joined to file paths.
- **Untrusted text stays text.** Session titles and reports are drawn with `textContent` and DOM calls only, never as HTML.
- **Never writes.** It opens the app's files read-only and writes no files at all. Archiving is done by Claude in the app, from an instruction you copy and paste yourself.
- **No network of its own.** No requests to other machines, no telemetry, fonts or CDNs (the one request it sends goes to its own port on 127.0.0.1, see the limits below). Zero runtime dependencies. To name projects it checks the folders sessions ran in, but skips network paths (`\\server\share`, `//server/share`). A folder on a mapped network drive looks like a local path, so the operating system may reach that share; each check gives up after half a second.
- **Less data in memory.** Session fields it does not use (for example MCP server settings) are dropped right after reading and never reach the page.

`npm run arch` checks several of these on every run: no `fetch` outside one client file, no HTML string injection, and no write APIs in the code that touches the file system.

## Limits

- **Programs running as you can read the board**, just as they can read the app's files directly. Pigeonholes adds no login. It does not protect you from malware or anyone else who can run programs under your account.
- **Other user accounts on the same computer can connect to 127.0.0.1 ports.** The app's files are protected by file permissions; the board is not. On a shared computer, stop the board when you are not using it.
- **Never expose the port.** Do not forward it, tunnel it, put it behind a reverse proxy, or change the code to listen on another address. The Host allowlist stops most of these, but do not rely on it alone.
- **Something else can answer on the board's port.** When the port is in use, the board asks that port whether a Pigeonholes board is there (`/api/hello`). Any program can answer the same way, so the terminal only says it looks like a board and suggests another port if you did not start one. Open the address the board you started printed.
- **The browser remembers your view choices** for this address (`127.0.0.1:<port>`): the language, the switches, the view (list or canvas), which piles and project groups you opened, by folder name, where each project's sheet sits on the canvas, by folder name (kept 7 days after the project leaves the board), and which sessions you copied a hand-off instruction for (the session ID, the time and the context percentage, kept 24 hours). A page served later on the same address and port in the same browser could read them; clear the site data if that matters.
- **Read the instruction before you send it.** The copied texts are plain text and the board sends none of them itself. The archive instruction is three lines, then session IDs. The hand-off instruction asks Claude to stop at a safe point, write a brief, and ask you once before it starts a new session; it carries the context percentage and, for a session too full to answer, that session's ID, and nothing else from the board. Check either before pasting it into Claude.
