import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceDetailValue } from '../public/source-detail.mjs';

function withDocument(run) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return {
        tagName,
        attributes: {},
        children: [],
        textContent: '',
        setAttribute(name, value) { this.attributes[name] = value; },
        append(child) { this.children.push(child); },
      };
    },
  };
  try { run(); } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

function textOf(node) {
  return `${node.textContent}${node.children.map(textOf).join('')}`;
}

const t = (key) => ({
  'source.claude': 'Claude Code',
  'source.codex': 'Codex CLI',
  'source.copilot': 'GitHub Copilot',
  'source.opencode': 'OpenCode',
  'graph.executionLocation.wsl': 'WSL',
  'detail.sourceProvenance.copilot': 'CLI or app is unknown',
  'detail.sourceProvenance.opencode': 'Launch client is unknown',
}[key] ?? key);

test('provider details state provenance limits while Claude and Codex remain unchanged', () => {
  withDocument(() => {
    const claude = sourceDetailValue(t, { source: 'claude' }, {});
    const codex = sourceDetailValue(t, { source: 'codex' }, { executionLocation: 'wsl' });
    const copilot = sourceDetailValue(t, { source: 'copilot' }, {});
    const opencode = sourceDetailValue(t, { source: 'opencode' }, {});

    assert.equal(textOf(claude), 'Claude Code');
    assert.equal(textOf(codex), 'Codex CLI — WSL');
    assert.equal(textOf(copilot), 'GitHub CopilotCLI or app is unknown');
    assert.equal(textOf(opencode), 'OpenCodeLaunch client is unknown');
    assert.equal(claude.children.length, 1);
    assert.equal(codex.children.length, 1);
    assert.equal(copilot.children[1].tagName, 'small');
    assert.equal(opencode.children[1].tagName, 'small');
  });
});
