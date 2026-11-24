// Turn files into boxes: one box per (role x feature group), plus one box per outside partner.
import { InputError, ROLES } from '../shared/map-shape.mjs';

/** Feature group of a file: the first word of its file name (`roster-core.js` -> `roster`). */
export function groupOf(path) {
  const base = path.split('/').pop();
  const word = base.split(/[-._]/)[0];
  return (word || base).toLowerCase();
}

/**
 * A short name for an outside partner, from the "相手" cell of the boundary table.
 * Takes the last "→" hop, cuts at the first bracket or code span, drops a trailing "の".
 */
export function outsideName(partnerCell) {
  let flat = partnerCell;
  for (let prev = ''; prev !== flat;) { prev = flat; flat = flat.replace(/（[^（）]*）|\([^()]*\)/g, ''); }
  const hop = flat.split('→').pop().trim();
  const cut = (s, re) => s.split(re)[0].trim().replace(/\s*の$/, '').trim();
  const short = cut(hop, /[（(`]/);
  if (short) return short;
  return cut(hop.replace(/`/g, ''), /[（(]/) || hop.replace(/`/g, '').trim();
}

/** Check and normalise the --labels JSON. */
export function normaliseLabels(raw) {
  if (raw == null) return { groups: Object.create(null), outside: Object.create(null) };
  const bad = () => new InputError('--labels の JSON の形が違う ({ "groups": { "roster": "名簿" }, "outside": { "Claude API": "AI" } } の形にする)');
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  const pick = (o) => {
    if (o == null) return Object.create(null);
    if (typeof o !== 'object' || Array.isArray(o)) throw bad();
    for (const v of Object.values(o)) if (typeof v !== 'string' || !v.trim()) throw bad();
    return Object.assign(Object.create(null), o); // no prototype: "constructor" is not a label
  };
  return { groups: pick(raw.groups), outside: pick(raw.outside) };
}

/** Label for an outside partner: exact key, then a key found in the 相手 cell, then in the adapter cell. */
export function outsideLabel(name, boundary, outsideLabels) {
  if (Object.hasOwn(outsideLabels, name)) return outsideLabels[name];
  const keys = Object.keys(outsideLabels);
  const inPartner = keys.find((k) => boundary.partnerCell.includes(k));
  if (inPartner) return outsideLabels[inPartner];
  const inAdapter = keys.find((k) => boundary.adapterCell.includes(k));
  return inAdapter ? outsideLabels[inAdapter] : name;
}

const boxId = (column, label) => `${column}:${label}`;

/**
 * Build boxes (without positions) and the outside edges.
 * Groups that get the same label inside one role share one box.
 * @returns {{ boxes: object[], fileToBox: Map<string,string>, outsideEdges: {from,to,count,kind}[], notices: string[] }}
 */
export function buildBoxes(roles, boundaries, labels) {
  const byId = new Map();
  const fileToBox = new Map();
  const notices = [];
  for (const role of ROLES) {
    for (const path of roles[role] || []) {
      if (fileToBox.has(path)) { notices.push(`${path} が表 1 の 2 つの役割に載っている (最初の ${fileToBox.get(path).split(':')[0]} で数えた)`); continue; }
      const group = groupOf(path);
      const label = Object.hasOwn(labels.groups, group) ? labels.groups[group] : group;
      const id = boxId(role, label);
      const box = byId.get(id) || { id, column: role, label, groups: [], files: [], partners: [] };
      byId.set(id, {
        ...box,
        groups: box.groups.includes(group) ? box.groups : [...box.groups, group],
        files: [...box.files, path],
      });
      fileToBox.set(path, id);
    }
  }
  const edgeCount = new Map();
  const edgeWhat = new Map();
  for (const b of boundaries) {
    const from = fileToBox.get(b.file);
    if (!from) { notices.push(`外部境界表の ${b.file} は役割対応表に無いので、外への線を引かなかった`); continue; }
    const name = outsideName(b.partnerCell);
    const label = outsideLabel(name, b, labels.outside);
    const id = boxId('outside', label);
    const box = byId.get(id) || { id, column: 'outside', label, groups: [], files: [], partners: [] };
    const partner = b.partnerCell.replace(/`/g, '');
    byId.set(id, {
      ...box,
      groups: box.groups.includes(name) ? box.groups : [...box.groups, name],
      partners: box.partners.includes(partner) ? box.partners : [...box.partners, partner],
    });
    const key = `${from}\u0000${id}`;
    edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    // What the line does: which file talks to the outside partner (the table's own words stay in the box panel).
    const what = edgeWhat.get(key) || [];
    const file = b.file.split('/').pop();
    if (!what.includes(file)) what.push(file);
    edgeWhat.set(key, what);
  }
  const outsideEdges = [...edgeCount].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, count, kind: 'outside', names: (edgeWhat.get(key) || []).map((f) => `${f} がやり取り`), more: 0 };
  });
  return { boxes: [...byId.values()], fileToBox, outsideEdges, notices };
}
