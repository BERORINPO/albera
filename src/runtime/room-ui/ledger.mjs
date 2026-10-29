// Today's ledger (part C): the bottom-right list of what the AI did and what you decided.
// Newest at the bottom, at most 6 rows. hands_step rows collapse to one line per VM (updated in place),
// so the list is about decisions and events, not every step. Text goes in with textContent only.

export const LEDGER_ROWS = 6;

/** hh:mm of an epoch ms (the viewer's local time). @param {number} at */
export function clockOf(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The camera label of a VM id: labelOf(vmId) when given and non-empty, else the id. */
export function camLabel(vmId, labelOf) {
  if (!vmId) return '';
  const label = typeof labelOf === 'function' ? labelOf(vmId) : null;
  return typeof label === 'string' && label ? label : vmId;
}

/**
 * Params a ledger line needs, with nested codes turned into words.
 * @param {{t: Function}} words @param {any} entry @param {(vmId: string) => string} [labelOf]
 */
export function entryParams(words, entry, labelOf) {
  const p = entry.params ?? {};
  return {
    ...p,
    cam: camLabel(entry.vmId, labelOf),
    doing: p.note || p.action || '',
    outcomeText: p.outcome ? words.t(`outcome_${p.outcome}`, {}) : '',
    effectText: p.effect ? words.t(`effect_${p.effect}`, {}) : '',
    whatText: p.what ? words.t(`what_${p.what}`, {}) : '',
    kindText: p.kind ? words.t(`fig_${p.kind}_kind`, {}) : '',
  };
}

/** One ledger line (no time). @param {{t: Function}} words @param {any} entry @param {(vmId: string) => string} [labelOf] */
export function entryText(words, entry, labelOf) {
  return words.t(`led_${entry.code}`, entryParams(words, entry, labelOf));
}

/**
 * Pure: the next row list after one entry. A row is {key, entry}; a hands_step row has key `step:<vmId>`
 * and replaces the earlier step row of that VM in place. Returns {rows, added, replaced}.
 * @param {{key: string, entry: any}[]} rows @param {any} entry
 */
export function nextRows(rows, entry, max = LEDGER_ROWS) {
  const key = entry.code === 'hands_step' ? `step:${entry.vmId}` : `seq:${entry.seq}`;
  const at = rows.findIndex((r) => r.key === key);
  if (at >= 0) {
    const next = rows.map((r, i) => (i === at ? { key, entry } : r));
    return { rows: next, added: null, replaced: key };
  }
  const grown = [...rows, { key, entry }];
  return { rows: grown.slice(Math.max(0, grown.length - max)), added: key, replaced: null };
}

/** @param {HTMLElement} el @param {{words: {t: Function}, labelOf?: (vmId: string) => string}} options */
export function createLedger(el, { words, labelOf }) {
  el.classList.add('rf-ledger');
  const title = document.createElement('div');
  title.className = 'rf-ledger-t';
  title.textContent = words.t('ledger_title', {});
  const list = document.createElement('div');
  list.className = 'rf-ledger-rows';
  el.replaceChildren(title, list);
  /** @type {{key: string, entry: any}[]} */
  let rows = [];
  /** @type {Map<string, HTMLElement>} */
  const rowEls = new Map();

  function fill(rowEl, entry) {
    const [who, time, text] = rowEl.children;
    who.className = `rf-who rf-actor-${entry.actor}`;
    who.textContent = words.t(`actor_${entry.actor}`, {});
    time.textContent = clockOf(entry.at);
    text.textContent = entryText(words, entry, labelOf);
  }

  function add(entry) {
    if (!entry || typeof entry.code !== 'string') return;
    const { rows: next, added, replaced } = nextRows(rows, entry);
    rows = next;
    if (replaced) {
      fill(/** @type {HTMLElement} */ (rowEls.get(replaced)), entry);
      return;
    }
    const rowEl = document.createElement('div');
    rowEl.className = 'rf-row';
    rowEl.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    rowEl.children[1].className = 'rf-time';
    fill(rowEl, entry);
    rowEls.set(/** @type {string} */ (added), rowEl);
    list.append(rowEl);
    const keep = new Set(rows.map((r) => r.key));
    for (const [key, node] of rowEls) {
      if (keep.has(key)) continue;
      node.remove();
      rowEls.delete(key);
    }
  }

  return { add };
}
