// Pure projection of local graph relations for a session detail panel.

/** @param {any[]} edges @param {any} graph @param {string} nodeId @param {'evidence'|'explains'} kind @param {Set<string>} sessionIds */
function gapLinks(edges, graph, nodeId, kind, sessionIds) {
  const endpoint = `graph:${nodeId}`;
  return edges.flatMap((edge) => {
    if (edge.kind !== kind || (edge.from !== endpoint && edge.to !== endpoint)) return [];
    const other = edge.from === endpoint ? edge.to : edge.from;
    if (other.startsWith('graph:')) {
      const node = graph.nodes.find((item) => `graph:${item.id}` === other);
      return node ? [{ endpoint: 'graph', nodeId: node.id, kind: node.kind, title: node.title }] : [];
    }
    if (other.startsWith('session:')) {
      const id = other.slice('session:'.length);
      if (!sessionIds.has(id)) return [];
      const source = id.startsWith('codex_') ? 'codex' : id.startsWith('copilot_') ? 'copilot' : id.startsWith('opencode_') ? 'opencode' : 'claude';
      return [{ endpoint: 'session', source, shortId: id.slice(-12) }];
    }
    return [];
  });
}

/** @param {any[]} edges @param {string} sessionId @param {any} graph @param {Array<{id:string}>} sessions */
export function sessionRelationEntries(edges, sessionId, graph, sessions) {
  const endpoint = `session:${sessionId}`;
  const sessionIds = new Set(sessions.map((session) => session.id));
  return edges.flatMap((edge) => {
    if (edge.from !== endpoint && edge.to !== endpoint) return [];
    const other = edge.from === endpoint ? edge.to : edge.from;
    const direction = edge.from === endpoint ? 'out' : 'in';
    const base = { edgeId: edge.id, direction, kind: edge.kind, purpose: edge.purpose, status: edge.status };
    if (other.startsWith('graph:')) {
      const node = graph.nodes.find((item) => `graph:${item.id}` === other);
      if (!node) return [];
      if (node.kind === 'execution_profile') {
        const profile = {
          id: node.id,
          kind: node.kind,
          title: node.title,
          executionHarness: node.executionHarness,
          executionLocation: node.executionLocation,
          workspaceIsolation: node.workspaceIsolation,
          networkAccess: node.networkAccess,
          approvalMode: node.approvalMode,
        };
        return [{ ...base, endpoint: 'graph', node: profile }];
      }
      if (node.kind === 'understanding_gap') {
        const gap = {
          id: node.id,
          kind: node.kind,
          title: node.title,
          status: node.status,
          checkedPerson: node.checkedPerson,
          missingEvidence: node.missingEvidence,
          neededExplanation: node.neededExplanation,
          evidenceLinks: gapLinks(edges, graph, node.id, 'evidence', sessionIds),
          explanationLinks: gapLinks(edges, graph, node.id, 'explains', sessionIds),
        };
        return [{ ...base, endpoint: 'graph', node: gap }];
      }
      if (node.kind === 'obsidian_note') {
        return [{ ...base, endpoint: 'graph', node: { id: node.id, kind: node.kind, title: node.title } }];
      }
      return [{ ...base, endpoint: 'graph', node }];
    }
    if (other.startsWith('session:')) {
      const relatedSessionId = other.slice('session:'.length);
      return sessionIds.has(relatedSessionId)
        ? [{ ...base, endpoint: 'session', sessionId: relatedSessionId }]
        : [];
    }
    return [];
  });
}

/** Show absent comprehension-gap fields as unrecorded, not as evidence of no debt. @param {{checkedPerson?:string,missingEvidence?:string,neededExplanation?:string}} gap @param {(key:string,params?:Record<string,string>)=>string} t */
export function comprehensionGapSummary(gap, t) {
  const notRecorded = t('graph.notRecorded');
  return [
    t('graph.checkedPersonSummary', { name: gap.checkedPerson || notRecorded }),
    t('graph.missingEvidence', { text: gap.missingEvidence || notRecorded }),
    t('graph.neededExplanation', { text: gap.neededExplanation || notRecorded }),
  ];
}

/** @param {string} sessionId @param {(kind:'detail', id:string)=>boolean} openBar */
export function openRelatedSessionDetail(sessionId, openBar) {
  return openBar('detail', sessionId);
}

/** Resolve only a unique provider-scoped opaque suffix; collisions fail closed. @param {string} source @param {string} shortId @param {Array<{id:string}>} sessions */
export function resolveRelatedSessionShortId(source, shortId, sessions) {
  const prefix = source === 'codex' ? 'codex_' : source === 'copilot' ? 'copilot_' : source === 'opencode' ? 'opencode_' : source === 'claude' ? 'local_' : '';
  if (!prefix || !/^[a-f0-9]{12}$/.test(shortId)) return null;
  const matches = sessions.filter(({ id }) => id.startsWith(prefix) && id.endsWith(shortId));
  return matches.length === 1 ? matches[0].id : null;
}
