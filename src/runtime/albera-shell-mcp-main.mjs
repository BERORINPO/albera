import { runShellMcpEntry } from './albera-shell-mcp.mjs';

// The file Claude Code starts (`node albera-shell-mcp-main.mjs <flags>`, see albera-shell-mcp-args.mjs). It only runs the entry on the process's own streams.
process.exitCode = await runShellMcpEntry({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
