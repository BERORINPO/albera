// Pure projection of local graph relations for a session detail panel.

/** @param {any[]} edges @param {string} sessionId @param {any} graph @param {Array<{id:string}>} sessions */
export function sessionRelationEntries(edges, sessionId, graph, sessions) {
  const endpoint = `session:${sessionId}`;
  const sessionIds = new Set(sessions.map((session) => session.id));
  return edges.flatMap((edge) => {
    if (edge.from !== endpoint && edge.to !== endpoint) return [];
    const other = edge.from === endpoint ? edge.to : edge.from;
    const direction = edge.from === endpoint ? 'out' : 'in';
    const base = { direction, kind: edge.kind, purpose: edge.purpose, status: edge.status };
    if (other.startsWith('graph:')) {
      const node = graph.nodes.find((item) => `graph:${item.id}` === other);
      if (!node) return [];
      if (node.kind === 'execution_profile') {
        const profile = {
          id: node.id,
          kind: node.kind,
          title: node.title,
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
        };
        return [{ ...base, endpoint: 'graph', node: gap }];
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

/** @param {string} sessionId @param {(kind:'detail', id:string)=>boolean} openBar */
export function openRelatedSessionDetail(sessionId, openBar) {
  return openBar('detail', sessionId);
}
