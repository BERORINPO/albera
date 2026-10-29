// View-only desktop wall. All text is set with textContent / DOM APIs; nothing here changes a VM.
const POLL_MS = 2000;
const $ = (id) => document.getElementById(id);
const tiles = new Map();
let poller;

const NOTES = {
  pending: 'Waiting for the first frame',
  stale: 'Stale frame - the picture is old',
  error: 'Capture failed',
};

function pad(n) { return String(n).padStart(2, '0'); }
function clock() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeTile(index, vm) {
  const root = element('div', 'tile pending');
  const img = element('img');
  img.alt = `Screen of ${vm.label}`;
  img.hidden = true;
  const cam = element('span', 'cam', `CAM ${pad(index + 1)} · ${vm.label}`);
  const rec = element('span', 'rec', 'REC --:--:--');
  const note = element('span', 'note');
  root.append(img, cam, rec, note);
  return { root, img, rec, note, shown: null };
}

function update(tile, vm) {
  tile.root.className = `tile ${vm.status}`;
  tile.rec.textContent = `REC ${clock()}`;
  const text = vm.status === 'error' ? `${NOTES.error}: ${vm.error}` : (NOTES[vm.status] ?? '');
  tile.note.textContent = text;
  tile.note.hidden = text === '';
  if (vm.capturedAt && tile.shown !== vm.capturedAt) {
    tile.shown = vm.capturedAt;
    tile.img.src = `api/vms/${encodeURIComponent(vm.vmId)}/screen.png?t=${encodeURIComponent(vm.capturedAt)}`;
    tile.img.hidden = false;
  }
}

function render(list) {
  const wall = $('wall');
  list.forEach((vm, index) => {
    let tile = tiles.get(vm.vmId);
    if (!tile) {
      tile = makeTile(index, vm);
      tiles.set(vm.vmId, tile);
      wall.append(tile.root);
    }
    update(tile, vm);
  });
}

async function poll() {
  try {
    const response = await fetch('api/vms', { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) return showBootstrap('Enter the one-time code to view the wall.');
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    $('connection').textContent = 'Connected · view only';
    render(Array.isArray(body.vms) ? body.vms : []);
  } catch {
    $('connection').textContent = 'Wall host unavailable - retrying';
  }
}

function showBootstrap(message) {
  clearInterval(poller);
  poller = undefined;
  $('wall').hidden = true;
  $('bootstrap').hidden = false;
  $('connection').textContent = message;
}

function startWall() {
  $('bootstrap').hidden = true;
  $('wall').hidden = false;
  void poll();
  poller = setInterval(() => { void poll(); }, POLL_MS);
}

$('bootstrap-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('bootstrap-code');
  const status = $('bootstrap-status');
  try {
    const response = await fetch('api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ bootstrapCode: input.value }),
    });
    input.value = '';
    if (!response.ok) throw new Error(String(response.status));
    status.textContent = '';
    startWall();
  } catch {
    status.textContent = 'Could not unlock. Restart the wall and open the new URL.';
  }
});

void (async () => {
  const response = await fetch('api/vms', { cache: 'no-store', credentials: 'same-origin' }).catch(() => null);
  if (response?.ok) startWall();
  else showBootstrap('Enter the one-time code to view the wall.');
})();
