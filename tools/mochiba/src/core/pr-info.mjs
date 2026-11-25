// Turn `gh pr view --json title,body,url,statusCheckRollup` into what the side panel shows.

const REASON_MAX = 280;

/** The "why" of a PR: the first prose paragraph of its body, without markdown decoration. */
export function reasonOf(body) {
  if (!body) return '';
  const paragraphs = String(body)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p
      .split(/\r?\n/)
      .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*(```|---|\|)/.test(l))
      .map((l) => l.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '').replace(/[*_`]/g, '').trim())
      .filter(Boolean)
      .join(' '))
    .filter((p) => p && !/^🤖|Generated with/.test(p));
  const first = paragraphs[0] || '';
  return first.length > REASON_MAX ? `${first.slice(0, REASON_MAX - 1)}…` : first;
}

/** One line about CI. state: pass | fail | running | none */
export function ciOf(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (!checks.length) return { state: 'none', text: 'CI の記録なし' };
  const result = (c) => String(c.conclusion || c.state || '').toUpperCase();
  const failed = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(result(c)));
  if (failed.length) {
    const names = failed.map((c) => c.name || c.context || '?').slice(0, 3).join('・');
    return { state: 'fail', text: `CI 失敗 ${failed.length} / ${checks.length} (${names})` };
  }
  const running = checks.filter((c) => {
    const status = String(c.status || '').toUpperCase();
    return (status && status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(result(c));
  });
  if (running.length) return { state: 'running', text: `CI 実行中 ${running.length} / ${checks.length}` };
  return { state: 'pass', text: `CI 通過 ${checks.length} / ${checks.length}` };
}

/** PR entry stored in the map. */
export function summarisePr(number, view) {
  return {
    number,
    title: String(view.title || ''),
    reason: reasonOf(view.body),
    url: typeof view.url === 'string' && /^https:\/\//.test(view.url) ? view.url : '',
    ci: ciOf(view.statusCheckRollup),
  };
}
