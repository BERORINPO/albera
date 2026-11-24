// Story mode (紙芝居): walk through one PR on the map, one scene at a time.
// Scenes come from D.stories (made by core/story.mjs: automatic, or a --story JSON written by any AI).
const STORIES = Array.isArray(D.stories) ? D.stories : [];
const STORY = new Map(STORIES.map((s) => [s.key, s]));
const storyByPr = (n) => STORIES.find((s) => s.pr === n) || null;
let storyOn = false;
let storyKey = null;
let storyStep = 0;
const curStory = () => STORY.get(storyKey);
// #light / #dark given in the URL stays there when the story rewrites the address.
const themeHash = (sep) => { const m = location.hash.match(/(?:^#|&)(light|dark)(?=&|$)/); return m ? `${sep}${m[1]}` : ''; };

function openStory(key, step = 0) {
  if (!STORY.has(key)) return;
  listOpen = false;
  if (quizOn) closeQuiz();
  if (sel || egoActive) select(null);
  storyOn = true;
  storyKey = key;
  vp.classList.add('storying');
  $('card').hidden = false;
  $('storybtn').setAttribute('aria-pressed', 'true');
  showPanel();
  goStep(step);
}

/** Leave the story mode. Callers decide what the panel and the view show next. */
function closeStory() {
  if (!storyOn) return;
  storyOn = false;
  vp.classList.remove('storying', 'dim');
  $('card').hidden = true;
  $('storybtn').setAttribute('aria-pressed', 'false');
  for (const el of nodeEl.values()) el.classList.remove('inpath', 'lead');
  for (const p of edgeEl.values()) p.classList.remove('on');
  litIds = []; labelIds = []; backIds = new Set(); bothIds = new Set(); labelText = new Map(); virtLines = [];
  drawLabels();
  showPanel();
  try { history.replaceState(null, '', location.pathname + location.search + themeHash('#')); } catch (err) { /* file:// in some browsers */ }
}

function goStep(i) {
  const story = curStory();
  storyStep = Math.max(0, Math.min(story.steps.length - 1, i));
  const step = story.steps[storyStep];
  renderCard(story, step);
  renderPanel();
  frameStory(step.boxes, true);  // the zoom decides how big the words on the lines are, so frame first
  storyLight(step);
  try { history.replaceState(null, '', `#story=${encodeURIComponent(story.key)}&step=${storyStep + 1}${themeHash('&')}`); } catch (err) { /* ignore */ }
}

function storyLight(step) {
  vp.classList.add('dim');
  const on = new Set(step.boxes);
  for (const [k, el] of nodeEl) { el.classList.toggle('inpath', on.has(k)); el.classList.toggle('lead', k === step.lead); el.classList.remove('sel'); }
  // Several scene lines can ride one map edge (a request one way, the answer back): one label with
  // every distinct say, and light in each direction used.
  const byEdge = new Map();
  for (const l of step.lines.filter((x) => x.edge)) {
    const g = byEdge.get(l.edge) || { fwd: false, back: false, says: [] };
    byEdge.set(l.edge, { fwd: g.fwd || !l.back, back: g.back || l.back, says: l.say && !g.says.includes(l.say) ? [...g.says, l.say] : g.says });
  }
  const onIds = new Set(byEdge.keys());
  for (const [k, p] of edgeEl) p.classList.toggle('on', onIds.has(k));
  raise(onIds);
  litIds = [...onIds];
  backIds = new Set([...byEdge].filter(([, g]) => g.back && !g.fwd).map(([k]) => k));
  bothIds = new Set([...byEdge].filter(([, g]) => g.back && g.fwd).map(([k]) => k));
  labelText = new Map([...byEdge].map(([k, g]) => [k, g.says.join(' / ')]));
  labelIds = [...byEdge].filter(([, g]) => g.says.length).map(([k]) => k);
  virtLines = step.lines.filter((l) => !l.edge);
  drawLabels();
}

/** Bring the scene's boxes into the space above the card. */
function frameStory(ids, anim, card = $('card')) {
  const r = vp.getBoundingClientRect();
  const top = 24, side = 36, bottom = card.offsetHeight + 40;
  const availW = Math.max(200, r.width - side * 2), availH = Math.max(160, r.height - top - bottom);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const id of ids) {
    const b = BOX.get(id);
    x0 = Math.min(x0, b.x - 30); y0 = Math.min(y0, b.y - 30); x1 = Math.max(x1, b.x + b.w + 30); y1 = Math.max(y1, b.y + b.h + 30);
  }
  view.s = Math.max(ZMIN, Math.min(1.1, availW / (x1 - x0), availH / (y1 - y0)));
  view.x = side + (availW - (x1 - x0) * view.s) / 2 - x0 * view.s;
  view.y = top + (availH - (y1 - y0) * view.s) / 2 - y0 * view.s;
  apply(anim);
}

// ---------- the card at the bottom ----------
const boxName = (id) => (BOX.has(id) ? BOX.get(id).label : id);
function fileBadge(f) {
  return h('a', { class: `fb${f.changed ? ' fb--chg' : ''}`, href: vscodeHref(f.path), title: `VS Code で開く: ${osPath(f.path)}` },
    f.path, f.changed && (f.added || f.deleted) ? h('em', { text: `+${f.added} −${f.deleted}` }) : null);
}
function renderCard(story, step) {
  $('cn').textContent = String(storyStep + 1);
  $('csay').textContent = step.say;
  const rows = [];
  const row = (k, kids) => rows.push(h('span', { class: 'card__k', text: k }), h('span', { class: 'chips' }, kids));
  const virt = step.lines.filter((l) => !l.edge);
  if (step.names.length) row('名前', step.names.map((n) => h('span', { class: 'chip', text: n })));
  if (virt.length) row('地図に無い線', virt.map((l) => h('span', { class: 'chip chip--virt', text: `${boxName(l.from)} → ${boxName(l.to)}${l.say ? ` : ${l.say}` : ''}` })));
  if (step.files.length) row('ファイル', step.files.map(fileBadge));
  $('crows').replaceChildren(...rows);
  $('cnote').hidden = !step.note;
  $('cnote').textContent = step.note || '';
  $('ccount').textContent = `${storyStep + 1} / ${story.steps.length}`;
  $('cdots').replaceChildren(...story.steps.map((s, k) => h('i', { class: `dot${k === storyStep ? ' now' : ''}` })));
  $('cprev').disabled = storyStep === 0;
  $('cnext').disabled = storyStep === story.steps.length - 1;
}
$('cprev').onclick = () => goStep(storyStep - 1);
$('cnext').onclick = () => goStep(storyStep + 1);

// ---------- the side panel while a story is open ----------
function storyPanel() {
  const story = curStory();
  setOpens();
  const info = story.pr !== null ? D.prs[story.pr] : null;
  const kids = [
    h('div', { class: 'backs' }, h('span'), h('button', { type: 'button', class: 'back', onclick: () => { closeStory(); renderPanel(); fitAll(true); }, text: '閉じる ×' })),
    h('div', { class: 'kicker', text: story.source === 'file' ? '紙芝居 ・ AI が書いた文 (--story)' : '紙芝居 ・ git と表から自動で作った (AI は使っていない)' }),
    h('h2', { text: story.title }),
  ];
  if (info && !info.missing) {
    kids.push(h('div', {}, info.url ? h('a', { href: info.url, target: '_blank', rel: 'noopener noreferrer', text: 'PR を開く' }) : null, ' ', h('span', { class: `ci ci--${info.ci.state}`, text: info.ci.text })));
  }
  kids.push(sec(`コマ (${story.steps.length}) ・ 押すと飛ぶ`, h('ol', { class: 'scenes' }, story.steps.map((s, k) => h('li', { class: k < storyStep ? 'past' : null },
    h('button', { type: 'button', 'aria-current': k === storyStep ? 'step' : null, onclick: () => goStep(k) },
      h('span', { class: 'rn', text: String(k + 1) }), h('span', { text: s.title })))))));
  if (STORIES.length > 1) {
    kids.push(sec(`ほかの紙芝居 (${STORIES.length})`, h('div', { class: 'stories' }, STORIES.map((s) => h('button', { type: 'button', 'aria-pressed': String(s.key === story.key), onclick: () => openStory(s.key, 0) },
      s.title, h('small', { class: 'muted', text: `  ${s.steps.length} コマ${s.source === 'file' ? ' ・ AI が書いた' : ''}` }))))));
  }
  kids.push(sec('AI に詳しく書かせる',
    h('p', { class: 'muted', text: 'Copilot・Codex・Claude のどれかに貼ると、普通の言葉のコマを JSON で書いてくれる。保存して --story で渡すと、この紙芝居と差し替わる' }),
    h('button', { type: 'button', onclick: () => copyText(storyPrompt(story), '頼み文をコピーした'), text: 'AI に書かせる文をコピー' })));
  panel.replaceChildren(...kids);
}

/** The request to paste into any AI: the JSON shape, the box ids it may use and the lines between them. */
function storyPrompt(story) {
  const info = story.pr !== null ? D.prs[story.pr] : null;
  const what = story.pr !== null ? `PR #${story.pr}${info && info.title ? ` 「${info.title}」` : ''}` : 'PR を通っていない変更';
  const commits = D.changes.filter((c) => (story.pr === null ? c.pr === null : c.pr === story.pr)).map((c) => `- ${c.short} ${c.subject}`);
  const inStory = new Set(story.steps.flatMap((s) => s.boxes));
  const boxes = D.boxes.map((b) => `- ${b.id} ・ ${COLUMN_NAMES[b.column] || b.column}${b.files.length ? ` ・ ${b.files.slice(0, 4).map((f) => f.path).join(', ')}${b.files.length > 4 ? ` ほか ${b.files.length - 4}` : ''}` : ''}`);
  const lines = EDGE.filter((e) => inStory.has(e.from) || inStory.has(e.to)).map((e) => `- ${e.from} → ${e.to} ・ ${whatOf(e) || 'やり取り'}`);
  const shape = { pr: story.pr, title: '短い題', steps: [{ title: '10 字くらい', say: '普通の言葉で 1 文', boxes: ['<箱の id>'], lead: '<箱の id>', lines: [{ from: '<箱の id>', to: '<箱の id>', say: '運ぶ物' }], names: ['関数の名前'], files: ['相対パス'], note: '補足 1 行 (任意)' }],
    questions: [
      { ask: '発表で聞かれそうな問い (道を答える)', how: 'どこから押すかのヒント', path: ['<箱の id>', '<箱の id>', '<箱の id>'], says: ['1 つ目と 2 つ目の間を運ぶ物', '2 つ目と 3 つ目の間'], side: ['<寄り道の箱 (任意)>'], answer: ['答え 1 行目', '答え 2 行目'], names: ['関数の名前'], files: ['相対パス'] },
      { ask: '当てはまる箱を全部答える問い', set: ['<箱の id>', '<箱の id>'], answer: ['答え 1 行'] }] };
  return [
    'mochiba (持ち場) の「紙芝居」を JSON で書いてください。',
    `対象: ${D.root} の ${what}`,
    ...(commits.length ? ['commit:', ...commits] : []),
    '',
    '手順:',
    `1. ${story.pr !== null ? `gh pr diff ${story.pr}` : 'git log -p'} で変更を読む`,
    '2. 処理が流れる順に 4〜10 コマに分ける (1 コマ = 1 つの出来事)',
    '3. 各コマ: title = 10 字くらいの見出し / say = そのコマで起きることを、コードの名前を使わない普通の日本語 1 文で (使う人の目線で) / boxes = 関わる箱の id (下の一覧にある物だけ) / lead = 主役の箱 / lines = 箱から箱へ何が渡るか (from と to は箱の id、say は運ぶ物を普通の言葉で短く) / names = 関わる関数や変数の名前 (小さく添えるだけ) / files = 関わるファイル (対象フォルダからの相対パス) / note = 補足 1 行 (任意)',
    '4. 説明の練習の問いを 2〜4 個: 発表で聞かれそうな事を、地図の箱を押して答える形に。path = 通る箱を順に 2〜8 個 (同じ箱は 2 回使わない)、set = 当てはまる箱を全部 (順番は自由)。答えは本当にコードがそう動く物だけ',
    '5. 次の形の JSON だけを返す (説明の文は付けない)',
    JSON.stringify(shape),
    '',
    '保存したら、地図を書き出す時に --story を足す (いつも付けている --labels などはそのまま):',
    `node src/entry/cli.mjs map "${D.root}" --since ${D.since} --story <保存したファイル>`,
    '',
    '箱の一覧 (id ・ 層 ・ 中のファイル):',
    ...boxes,
    '',
    '線の一覧 (この変更に関わる箱の物。from → to ・ from が使う物):',
    ...lines,
  ].join('\n');
}

document.addEventListener('keydown', (e) => {
  const t = e.target instanceof Element ? e.target : document.body;
  if (!storyOn || t.closest('input, textarea')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); goStep(storyStep + 1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goStep(storyStep - 1); }
});
