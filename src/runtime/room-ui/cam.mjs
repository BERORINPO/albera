// A camera on the room canvas (spec/room.md §5, part B): the VM's live screen with the AI cursor drawn over it.
// Text is set with textContent only. The band shows what the AI reports; a DONE stays a claim unless ALBERA's own
// automatic check of that run passed (vm.check, spec/room.md §7), which is shown until the VM's next run.
const CLICKS = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_mouse_down', 'left_click_drag']);
const SPOT_MS = 1800;
const RIPPLE_MS = 700;

const pad = (n) => String(n).padStart(2, '0');
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const screenUrl = (vmId, capturedAt) => `api/vms/${encodeURIComponent(vmId)}/screen.png?t=${encodeURIComponent(String(capturedAt ?? ''))}`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Where a VM-pixel point lands on an object-fit: contain image, as % of the box. null when it cannot be placed. */
export function cursorSpot(cursor, natural, box) {
  if (!Array.isArray(cursor) || !natural?.w || !natural?.h || !box?.w || !box?.h) return null;
  const scale = Math.min(box.w / natural.w, box.h / natural.h);
  const left = (box.w - natural.w * scale) / 2 + cursor[0] * scale;
  const top = (box.h - natural.h * scale) / 2 + cursor[1] * scale;
  return { left: (left / box.w) * 100, top: (top / box.h) * 100 };
}

const CHECK_STATES = new Set(['checking', 'passed', 'failed', 'unavailable']);

/** The automatic check of a VM's DONE claim, when there is one for its finished run (else null). */
function checkOf(agent, check) {
  if (agent?.state !== 'done' || agent.outcome !== 'claimed_done' || !CHECK_STATES.has(check?.state)) return null;
  return check;
}

/** The tone of a camera from its frame, its hands and its check: work | wait | stuck | done | off. */
export function camTone(vm) {
  const agent = vm?.agent;
  if (vm?.status === 'error') return 'stuck';
  if (!agent || agent.state === 'idle') return 'off';
  const check = checkOf(agent, vm?.check);
  if (check) return check.state === 'passed' ? 'done' : check.state === 'checking' ? 'wait' : 'stuck';
  if (agent.state === 'done') return agent.outcome === 'claimed_done' ? 'wait' : 'stuck';
  return vm.status === 'stale' ? 'stuck' : 'work';
}

const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

/**
 * The band under the screen: the AI's own report while it runs, a claim (dashed) when it ended.
 * A DONE whose automatic check passed is shown as verified (`verified: true`); a failed or unavailable check keeps
 * the claim wording and adds what the check found.
 */
export function bandText(agent, t, vmCheck = null) {
  if (!agent || agent.state === 'idle') return { text: t('cam.idle'), claim: false };
  const check = checkOf(agent, vmCheck);
  if (check) {
    const claim = agent.claim || t('cam.no_message');
    if (check.state === 'passed') return { text: t('cam.verified', { ok: count(check.checks) - count(check.failed), checks: count(check.checks) }), claim: false, verified: true };
    if (check.state === 'checking') return { text: t('cam.checking', { claim }), claim: true };
    return { text: t(`cam.claim_${check.state}`, { claim, detail: String(check.detail ?? '') }), claim: true };
  }
  if (agent.state === 'done') {
    if (agent.outcome === 'claimed_done' || agent.outcome === 'claimed_failed') {
      return { text: t('cam.claim', { claim: agent.claim || t('cam.no_message') }), claim: true };
    }
    return { text: t('cam.ended', { outcome: t(`cam.outcome.${agent.outcome ?? 'error'}`) }), claim: true };
  }
  const usd = Number.isFinite(agent.usd) ? agent.usd.toFixed(3) : '0.000';
  return { text: t('cam.band', { step: agent.step ?? 0, action: agent.lastAction ?? '-', usd }), claim: false };
}

/** createCam(vm, { index, words }) -> { el, update(vm) }. The canvas places `el` as node `cam:<vmId>`. */
export function createCam(vm, { index = 0, words } = {}) {
  const t = typeof words?.t === 'function' ? (code, params) => words.t(code, params) : (code) => code;
  const label = String(vm?.label ?? vm?.vmId ?? '');
  const el = element('div', 'room-cam tone-off');
  el.dataset.vm = String(vm?.vmId ?? '');
  const head = element('div', 'cam-hd');
  const title = element('span', 'cam-title', t('cam.title', { n: pad(index + 1), label }));
  const rec = element('span', 'cam-rec', t('cam.rec', { time: '--:--:--' }));
  head.append(title, rec);
  const screen = element('div', 'cam-scr');
  const img = element('img', 'cam-img');
  img.alt = t('cam.screen_alt', { label });
  img.hidden = true;
  img.decoding = 'async';
  const dot = element('span', 'cam-cur');
  dot.hidden = true;
  const note = element('span', 'cam-note');
  note.hidden = true;
  screen.append(img, dot, note);
  const foot = element('div', 'cam-ft');
  const pill = element('span', 'cam-pill');
  const band = element('span', 'cam-band');
  foot.append(pill, band);
  el.append(head, screen, foot);

  const state = { shown: null, cursor: null, actions: null, lastAction: null };

  function placeDot() {
    const spot = cursorSpot(state.cursor, { w: img.naturalWidth, h: img.naturalHeight }, { w: screen.clientWidth, h: screen.clientHeight });
    dot.hidden = !spot || img.hidden;
    if (!spot) return null;
    dot.style.left = `${spot.left.toFixed(2)}%`;
    dot.style.top = `${spot.top.toFixed(2)}%`;
    return spot;
  }

  function ripple() {
    if (dot.hidden) return;
    const ring = element('span', 'cam-rip');
    ring.style.left = dot.style.left;
    ring.style.top = dot.style.top;
    screen.append(ring);
    setTimeout(() => ring.remove(), RIPPLE_MS);
  }

  function updateAgent(agent, check) {
    const running = agent?.state === 'running';
    state.cursor = running ? agent.cursor : null;
    placeDot();
    const grew = running && state.actions !== null && Number.isSafeInteger(agent.actions) && agent.actions > state.actions;
    if (grew && CLICKS.has(agent.lastAction)) ripple();
    state.actions = Number.isSafeInteger(agent?.actions) ? agent.actions : null;
    const { text, claim, verified = false } = bandText(agent, t, check);
    band.textContent = text;
    el.classList.toggle('claim', claim);
    el.classList.toggle('verified', verified);
  }

  function update(next) {
    if (!next || typeof next !== 'object') return;
    const tone = camTone(next);
    el.className = `${el.className.split(' ').filter((c) => !c.startsWith('tone-') && !c.startsWith('st-')).join(' ')} tone-${tone} st-${next.status ?? 'pending'}`;
    pill.textContent = t(`cam.tone.${tone}`);
    const live = next.status === 'live';
    rec.textContent = live ? t('cam.rec', { time: clock() }) : t('cam.rec_off');
    const noteText = next.status === 'error' ? t('cam.note.error', { code: String(next.error ?? '') })
      : next.status === 'stale' ? t('cam.note.stale')
        : next.status === 'pending' ? t('cam.note.pending') : '';
    note.textContent = noteText;
    note.hidden = noteText === '';
    if (next.capturedAt && state.shown !== next.capturedAt) {
      state.shown = next.capturedAt;
      img.src = screenUrl(next.vmId, next.capturedAt);
      img.hidden = false;
    }
    updateAgent(next.agent ?? null, next.check ?? null);
  }

  img.addEventListener('load', placeDot);
  update(vm);
  return { el, update };
}

/** Ctrl twice: darken every camera except the AI cursors for 1.8 s, so you can see where all the hands are. */
export function spotlight(canvas, vmIds) {
  const root = canvas?.world;
  if (!root || typeof root.querySelector !== 'function') return;
  const els = (Array.isArray(vmIds) ? vmIds : [])
    .map((vmId) => root.querySelector(`.room-cam[data-vm="${CSS.escape(String(vmId))}"]`))
    .filter(Boolean);
  root.classList.add('cam-spotlight');
  for (const el of els) el.classList.add('spot');
  setTimeout(() => {
    root.classList.remove('cam-spotlight');
    for (const el of els) el.classList.remove('spot');
  }, SPOT_MS);
}
