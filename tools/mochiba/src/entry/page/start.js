// Start-up: theme, arrangement buttons, first layout and the #sel= / #story= in the URL. Runs last.
// ---------- theme / start ----------
const root = document.documentElement;
let savedTheme = null;
try { savedTheme = localStorage.getItem('mochiba-theme'); } catch (err) { savedTheme = null; }
if (location.hash.includes('light')) root.dataset.theme = 'light';
else if (location.hash.includes('dark')) root.dataset.theme = 'dark';
else if (savedTheme === 'light' || savedTheme === 'dark') root.dataset.theme = savedTheme;
$('theme').addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('mochiba-theme', root.dataset.theme); } catch (err) { /* per-viewer convenience only */ }
});
// After the boxes moved (window size, arrangement, reset), frame again whatever is being looked at.
const reframe = (anim) => {
  if (storyOn) goStep(storyStep);
  else if (quizOn) { renderQuiz(); quizFrame(anim); }
  else if (sel) select(sel);
  else fitAll(anim);
};
window.addEventListener('resize', () => (storyOn ? frameStory(curStory().steps[storyStep].boxes, false) : quizOn ? quizFrame(false) : sel ? (egoActive && enterEgo(sel), focusBoxes([...roadsTo(sel).nodes])) : fitAll()));
renderPanel();
document.querySelectorAll('.mode button[data-mode]').forEach((btn) => {
  btn.hidden = !LAYOUTS[btn.dataset.mode];
  btn.onclick = () => {
    if (btn.dataset.mode === mode) return;
    mode = btn.dataset.mode;
    try { localStorage.setItem('mochiba:mode', mode); } catch (err) { /* ignore */ }
    egoActive = false; egoLanes = new Map(); world.classList.remove('ego');
    relayout();
    reframe(true);
  };
});
$('reset').onclick = () => { saveMoved(mode, {}); egoActive = false; egoLanes = new Map(); world.classList.remove('ego'); relayout(); reframe(true); };
{
  const sb = $('storybtn');
  sb.hidden = !STORIES.length;
  if (STORIES.length) sb.textContent = `紙芝居 ${STORIES.length}`;
  sb.setAttribute('aria-pressed', 'false');
  sb.onclick = () => {
    if (storyOn) { closeStory(); renderPanel(); fitAll(true); return; }
    // Stories written with --story come first, then the newest PR.
    openStory(STORIES[0].key, 0);
  };
}
{
  const qb = $('quizbtn');
  qb.hidden = !QUIZ_STORIES.length;
  qb.setAttribute('aria-pressed', 'false');
  qb.onclick = () => { if (quizOn) { closeQuiz(); renderPanel(); fitAll(true); return; } openQuiz(QUIZ_STORIES[0].key, 0); };
}
relayout();
fitAll();
const fromHash = (name) => {
  const m = location.hash.match(new RegExp(`[#&]${name}=([^&]+)`));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (err) { return null; /* a broken value is ignored */ }
};
const pre = fromHash('sel');
const preStory = fromHash('story');
const preQuiz = fromHash('quiz');
if (preQuiz !== null && STORY.has(preQuiz)) openQuiz(preQuiz, Math.max(0, (Number(fromHash('q')) || 1) - 1));
else if (preStory !== null && STORY.has(preStory)) openStory(preStory, Math.max(0, (Number(fromHash('step')) || 1) - 1));
else if (pre !== null && BOX.has(pre)) select(pre);
