// A small in-memory repo shared by the tests (no files on disk, so node --test never runs it as code under test).
import { resolve, join } from 'node:path';

export const ROOT = resolve('/work/demo');
export const CWD = resolve('/work/mochiba');

export const ARCH_MD = `# demo
## 1. 役割対応表
| 役割 | パス |
|---|---|
| shared | js/roster-schema.js |
| core | js/roster-core.js js/roster-day.js worker/ask-core.mjs |
| adapter | worker/anthropic.mjs worker/roster-db.mjs |
| entry | index.html js/app.js worker/index.mjs worker/ask.mjs js/gone.js |

- note line

## 2. 外部境界表
| adapter | 相手 | Fake |
|---|---|---|
| worker/anthropic.mjs | 同じ場所の Worker \`/api/read\`（画面）→ Claude API（Haiku） | fakeAnthropic |
| worker/roster-db.mjs | Cloudflare D1（\`DB\`、表 rosters） | fakeD1 |
| Cron Triggers → worker/index.mjs の \`scheduled()\` | \`* * * * *\`（wrangler.jsonc） | env |
`;

export const SOURCES = {
  'index.html': '<!doctype html><script src="js/app.js"></script><script src="https://cdn.example/x.js"></script>',
  'js/app.js': "import { a } from './roster-core.js';\nimport './roster-day.js';\nimport lib from 'some-package';",
  'js/roster-core.js': "import { S } from './roster-schema.js';\nexport const a = 1;",
  'js/roster-day.js': "import { a } from './roster-core.js';",
  'js/roster-schema.js': 'export const S = {};',
  'worker/index.mjs': "import { handle } from './ask.mjs';\nimport S from '../js/roster-schema.js';",
  'worker/ask.mjs': "import { callClaude } from './anthropic.mjs';\nimport { rules } from './ask-core.mjs';",
  'worker/ask-core.mjs': "export * from '../js/roster-core.js';",
  'worker/anthropic.mjs': 'export const callClaude = () => {};',
  'worker/roster-db.mjs': "const s = require('../js/roster-schema.js');",
};

const R = '\x1e';
const U = '\x1f';
const commit = (hash, parents, date, subject, body = '') => `${R}${hash}${U}${parents}${U}${date}${U}${subject}\n${body}`;
const h = (c) => c.repeat(40);

/** Newest first, children before parents (like --topo-order). */
export const LOG_TEXT = [
  commit(h('5'), h('4'), '2026-11-20T10:00:00+09:00', 'chore: tweak app', '\n1\t1\tjs/app.js\n'),
  commit(h('4'), `${h('1')} ${h('3')}`, '2026-11-19T18:00:00+09:00', 'Merge pull request #12 from me/feat'),
  commit(h('3'), h('2'), '2026-11-19T17:00:00+09:00', 'feat: add day view', '\n10\t2\tjs/roster-day.js\n create mode 100644 js/roster-day.js\n'),
  commit(h('2'), h('1'), '2026-11-19T16:00:00+09:00', 'fix: core', '\n3\t1\tjs/roster-core.js\n5\t0\ttest/x.test.mjs\n-\t-\timg/logo.png\n'),
  commit(h('1'), h('0'), '2026-11-18T09:00:00+09:00', 'docs: readme (#11)', '\n1\t0\tREADME.md\n'),
].join('');

export const PR_12 = {
  title: 'Add the day view',
  body: '## Summary\n\nStaff could not see today at a glance. **This** adds the day view.\n\n🤖 Generated with Claude Code',
  url: 'https://github.com/me/demo/pull/12',
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};

/** Absolute-path file map for the fake fs. */
export function repoFiles(extra = {}) {
  const files = { [join(ROOT, 'spec', 'architecture.md')]: ARCH_MD };
  for (const [p, t] of Object.entries(SOURCES)) files[join(ROOT, p)] = t;
  return { ...files, ...extra };
}
