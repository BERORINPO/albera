import { runDesktopMcpEntry } from './albera-desktop-mcp.mjs';

// The file Claude Code starts (`node albera-desktop-mcp-main.mjs <flags>`, see albera-desktop-mcp-args.mjs). It only runs the entry on the process's own streams.
process.exitCode = await runDesktopMcpEntry({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
