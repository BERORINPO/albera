// Starts the demo room and opens it in the browser with its one-time code, so nothing has to be typed or copied.
import { spawn } from 'node:child_process';
import path from 'node:path';

const [root, port] = process.argv.slice(2);
const entry = path.join(root, 'src', 'runtime', 'entry.mjs');
const child = spawn(process.execPath, ['--no-warnings', entry, 'room', '--demo', '--port', port], { stdio: ['ignore', 'pipe', 'inherit'] }); // the same console as this window, so closing the window ends the room too
let text = '';
let opened = false;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  if (opened) { process.stdout.write(chunk); return; } // the code line is already behind us, so the rest (Ctrl+C hint, errors) is safe to show
  text += chunk;
  const found = /bootstrap code: (\S+)\r?\n/u.exec(text); // wait for the end of the line so a code split across chunks is never cut short
  if (!found) return;
  const code = found[1];
  opened = true;
  console.log('The page is open in your browser. Close this window to stop the demo.');
  const rest = text.slice(found.index + found[0].length);
  if (rest) process.stdout.write(rest);
  if (process.env.ALBERA_DEMO_NOBROWSER) return;
  spawn('C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'start', '', `http://127.0.0.1:${port}/room/?demo=1#b=${code}`], { stdio: 'ignore', detached: true }).unref();
});
child.on('error', () => { console.log('NOT DONE: the demo could not start.'); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
