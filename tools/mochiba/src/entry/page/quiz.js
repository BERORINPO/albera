// Practice mode (説明の練習): answer by pointing at boxes in order; the page checks the picks against the map data.
// Questions are D.stories[].questions (core/quiz.mjs: made from the map, or written by any AI in --story).
const QUIZ_STORIES = STORIES.filter((s) => Array.isArray(s.questions) && s.questions.length);
let quizOn = false;
let quizKey = null;
let quizIdx = 0;
let picks = [];
let checked = false;
const curQuiz = () => STORY.get(quizKey);
const curQ = () => curQuiz().questions[quizIdx];
const RESULT_WORD = { ok: '合っている', order: '順番が違う', side: '寄り道 (数えない)', off: '道の外', miss: '抜け' };
const MARK_WORD = { ok: '言えた', vague: 'あいまい', no: '言えなかった' };

// ---------- what was said, kept in this browser only ----------
const QUIZ_STORE = `mochiba:quiz:${D.root}`;
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const goodEntry = (v) => v && typeof v === 'object' && Object.hasOwn(MARK_WORD, v.mark) && typeof v.day === 'string' && DAY.test(v.day) && typeof v.ask === 'string' && typeof v.story === 'string';
function loadSaid() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(QUIZ_STORE) || '{}'); } catch (err) { v = null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, e]) => goodEntry(e)));
}
let said = loadSaid();
const saidKey = (storyKey, qKey) => `${storyKey}\u0000${qKey}`;
const saidFor = (storyKey, q) => { const s = said[saidKey(storyKey, q.key)]; return s && s.ask === q.ask ? s : null; };
function mark(kind) {
  const story = curQuiz(), q = curQ();
  said = { ...said, [saidKey(story.key, q.key)]: { mark: kind, day: todayKey(), ask: q.ask, story: story.key } };
  try { localStorage.setItem(QUIZ_STORE, JSON.stringify(said)); } catch (err) { /* private mode: kept for this page only */ }
  toast(kind === 'ok' ? '言えた。もう一度の一覧から外した' : `${MARK_WORD[kind]}。次の日から「もう一度」の上に出る`);
  renderQuiz();
}

function openQuiz(key, idx = 0) {
  if (!STORY.has(key) || !STORY.get(key).questions.length) return;
  listOpen = false;
  if (storyOn) closeStory();
  if (sel || egoActive) select(null);
  quizOn = true;
  quizKey = key;
  vp.classList.add('quizzing');
  $('qcard').hidden = false;
  $('quizbtn').setAttribute('aria-pressed', 'true');
  showPanel();
  goQuestion(idx);
}

/** Leave the practice. Callers decide what the panel and the view show next. */
function closeQuiz() {
  if (!quizOn) return;
  quizOn = false;
  picks = []; checked = false;
  clearQuizMarks();
  vp.classList.remove('quizzing', 'dim');
  $('qcard').hidden = true;
  $('quizbtn').setAttribute('aria-pressed', 'false');
  litIds = []; labelIds = []; backIds = new Set(); bothIds = new Set(); labelText = new Map(); virtLines = [];
  for (const p of edgeEl.values()) p.classList.remove('on');
  drawLabels();
  showPanel();
  try { history.replaceState(null, '', location.pathname + location.search + themeHash('#')); } catch (err) { /* ignore */ }
}

/** Frame the map above the card: the whole map while answering, the answer and the picks after the check. */
let qcardHeight = 0;
function quizFrame(anim) {
  const q = curQ();
  const ids = checked ? [...new Set([...q.boxes, ...picks, ...(q.target ? [q.target] : [])])] : D.boxes.map((b) => b.id);
  qcardHeight = $('qcard').offsetHeight;
  frameStory(ids, anim, $('qcard'));
}

function goQuestion(i) {
  const story = curQuiz();
  quizIdx = Math.max(0, Math.min(story.questions.length - 1, i));
  picks = []; checked = false;
  renderQuiz();
  quizFrame(true);
  try { history.replaceState(null, '', `#quiz=${encodeURIComponent(story.key)}&q=${quizIdx + 1}${themeHash('&')}`); } catch (err) { /* ignore */ }
}

function quizPick(id) {
  if (checked) return;
  picks = picks.includes(id) ? picks.filter((x) => x !== id) : [...picks, id];
  renderQuiz();
  if ($('qcard').offsetHeight !== qcardHeight) quizFrame(true);  // the picked list wrapped: keep the map clear of the card
}
function quizCheck() {
  if (!picks.length) return;
  checked = true;
  renderQuiz();
  quizFrame(true);
}

// ---------- the map ----------
function clearQuizMarks() {
  for (const el of nodeEl.values()) {
    el.classList.remove('picked', 'inpath', 'lead', 'r-ok', 'r-order', 'r-side', 'r-off', 'r-miss');
    el.querySelectorAll('.pk, .rk').forEach((x) => x.remove());
  }
}
function quizMap(q) {
  clearQuizMarks();
  const res = checked ? gradePicks(q, picks) : new Map();
  picks.forEach((id, i) => {
    const el = nodeEl.get(id);
    el.classList.add('picked');
    el.append(h('i', { class: 'pk', text: String(i + 1) }));
  });
  for (const [id, r] of res) {
    const el = nodeEl.get(id);
    el.classList.add('inpath', `r-${r}`);
    el.append(h('i', { class: 'rk', text: RESULT_WORD[r] }));
  }
  if (checked && q.target) nodeEl.get(q.target).classList.add('inpath', 'lead');
  vp.classList.toggle('dim', checked);
  // After the check, the answer's own lines light up with what they carry.
  const lines = checked ? q.lines : [];
  const onIds = new Set(lines.filter((l) => l.edge).map((l) => l.edge));
  for (const [k, p] of edgeEl) p.classList.toggle('on', onIds.has(k));
  raise(onIds);
  litIds = [...onIds];
  backIds = new Set(lines.filter((l) => l.edge && l.back).map((l) => l.edge));
  bothIds = new Set();
  labelText = new Map(lines.filter((l) => l.edge && l.say).map((l) => [l.edge, l.say]));
  labelIds = [...labelText.keys()];
  virtLines = lines.filter((l) => !l.edge);
  drawLabels();
}

// ---------- the card ----------
const boxWithLayer = (id) => { const b = BOX.get(id); return [b.label, h('small', { text: COLUMN_NAMES[b.column] || '' })]; };
function renderQuizCard(q) {
  const story = curQuiz();
  const res = checked ? gradePicks(q, picks) : null;
  $('qn').textContent = String(quizIdx + 1);
  $('qask').textContent = q.ask;
  $('qauto').hidden = q.source !== 'auto';
  $('qhow').replaceChildren(
    h('span', { class: 'how', text: checked ? '答え合わせ' : q.kind === 'path' ? '地図の箱を順に押して答える' : '当てはまる箱を全部押して答える' }),
    h('span', { class: 'muted', text: q.how }));
  const chips = picks.map((id, i) => h('span', { class: `pchip${res ? ` r-${res.get(id)}` : ''}` }, h('i', { text: String(i + 1) }), ...boxWithLayer(id)));
  if (res) for (const id of q.boxes) if (res.get(id) === 'miss') chips.push(h('span', { class: 'pchip r-miss' }, h('i', { text: '抜' }), ...boxWithLayer(id)));
  $('qpicks').replaceChildren(...(chips.length ? chips : [h('span', { class: 'muted', text: 'まだ押していない' })]));
  const after = $('qafter');
  after.hidden = !checked;
  if (checked) {
    const rows = [];
    if (q.names.length) rows.push(h('span', { class: 'card__k', text: '名前' }), h('span', { class: 'chips' }, q.names.map((n) => h('span', { class: 'chip', text: n }))));
    if (q.files.length) rows.push(h('span', { class: 'card__k', text: 'ファイル' }), h('span', { class: 'chips' }, q.files.map(fileBadge)));
    after.replaceChildren(
      ...q.answer.map((a) => h('div', { class: 'qans', text: `→ ${a}` })),
      rows.length ? h('div', { class: 'card__rows' }, rows) : null,
      q.note ? h('div', { class: 'card__note', text: q.note }) : null);
  }
  const s = saidFor(story.key, q);
  const btn = (text, onclick, cls, disabled) => h('button', { type: 'button', class: cls || null, onclick, disabled: disabled || null, text });
  $('qctl').replaceChildren(...(checked
    ? [h('b', { text: '自分の言葉で 1 回言ってみる' }), h('span', { class: 'muted', text: '見ずに、声に出して' }), h('span', { class: 'grow' }),
      ...['ok', 'vague', 'no'].map((k) => btn(MARK_WORD[k], () => mark(k), s && s.mark === k ? 'is-said' : null)),
      btn('やり直す', () => goQuestion(quizIdx)),
      btn(quizIdx < story.questions.length - 1 ? '次の問い →' : '最初の問いへ', () => goQuestion(quizIdx < story.questions.length - 1 ? quizIdx + 1 : 0), 'primary')]
    : [btn('1 つ戻す', () => { picks = picks.slice(0, -1); renderQuiz(); }, null, !picks.length), btn('やり直す', () => { picks = []; renderQuiz(); }, null, !picks.length),
      h('span', { class: 'grow' }), h('span', { class: 'count', text: `${quizIdx + 1} / ${story.questions.length}` }),
      btn('答え合わせ', quizCheck, 'primary', !picks.length)]));
}

// ---------- the side panel ----------
function againList() {
  const today = todayKey();
  return Object.entries(said)
    .filter(([, v]) => v && (v.mark === 'vague' || v.mark === 'no') && STORY.has(v.story))
    .map(([k, v]) => ({ k, v, due: v.day < today, idx: STORY.get(v.story).questions.findIndex((q) => saidKey(v.story, q.key) === k && q.ask === v.ask) }))
    .filter((x) => x.idx >= 0)
    .sort((a, b) => b.due - a.due || a.v.day.localeCompare(b.v.day));
}
function quizPanel() {
  const story = curQuiz();
  setOpens();
  const status = (q) => { const s = saidFor(story.key, q); return s ? MARK_WORD[s.mark] : 'まだ'; };
  const again = againList();
  const kids = [
    h('div', { class: 'backs' }, h('span'), h('button', { type: 'button', class: 'back', onclick: () => { closeQuiz(); renderPanel(); fitAll(true); }, text: '閉じる ×' })),
    h('div', { class: 'kicker', text: '説明の練習 ・ 地図を指して答える (答え合わせは地図のデータ)' }),
    h('h2', { text: story.title }),
    sec(`問い (${story.questions.length}) ・ 押すと飛ぶ`, h('ol', { class: 'scenes' }, story.questions.map((q, k) => h('li', {},
      h('button', { type: 'button', 'aria-current': k === quizIdx ? 'step' : null, onclick: () => goQuestion(k) },
        h('span', { class: 'rn', text: String(k + 1) }),
        h('span', {}, q.ask, h('small', { class: 'qstat', text: ` ${status(q)}${q.source === 'auto' ? ' ・ 地図から自動' : ''}` }))))))),
    sec(`もう一度 (${again.length})`, again.length
      ? h('ol', { class: 'scenes' }, again.map((x) => h('li', {}, h('button', { type: 'button', onclick: () => openQuiz(x.v.story, x.idx) },
        h('span', { class: 'rn', text: x.due ? '今日' : '明日' }), h('span', {}, x.v.ask, h('small', { class: 'qstat', text: ` ${MARK_WORD[x.v.mark]} ・ ${fmtDay(x.v.day)}` }))))))
      : h('p', { class: 'muted', text: '「あいまい」「言えなかった」がここに入る。次の日から上に出る' })),
  ];
  if (QUIZ_STORIES.length > 1) {
    kids.push(sec(`ほかの紙芝居の問い (${QUIZ_STORIES.length})`, h('div', { class: 'stories' }, QUIZ_STORIES.map((s) => h('button', { type: 'button', 'aria-pressed': String(s.key === story.key), onclick: () => openQuiz(s.key, 0) },
      s.title, h('small', { class: 'muted', text: `  ${s.questions.length} 問` }))))));
  }
  kids.push(h('div', { class: 'muted note', text: '点数は出さない。答えはこのブラウザの中だけに残り、どこにも送らない' }));
  panel.replaceChildren(...kids);
}

function renderQuiz() {
  const q = curQ();
  quizMap(q);
  renderQuizCard(q);
  renderPanel();
}

document.addEventListener('keydown', (e) => {
  const t = e.target instanceof Element ? e.target : document.body;
  if (!quizOn || t.closest('input, textarea')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); goQuestion(quizIdx + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); goQuestion(quizIdx - 1); }
  else if (e.key === 'Backspace' && !checked && picks.length) { e.preventDefault(); picks = picks.slice(0, -1); renderQuiz(); }
});
