// Keyboard-first graph card connection mode. The caller owns rendering and relation persistence.

/** @param {{cv:any,loadGraph:()=>any,render:()=>void,announce:(text:string)=>void,t:(key:string)=>string,focusTarget:(id:string)=>void}} o @param {string} id */
export function startGraphConnection(o, id) {
  if (!o.loadGraph().nodes.some((node) => node.id === id)) return false;
  o.cv.graphConnectFrom = id;
  o.render();
  o.announce(o.t('graph.connectPickTarget'));
  o.focusTarget(id);
  return true;
}

/** @param {{cv:any,render:()=>void,connect:(from:string,to:string)=>unknown}} o @param {string} id */
export function chooseGraphConnectionTarget(o, id) {
  const from = o.cv.graphConnectFrom;
  if (!from) return null;
  if (from === id) return false;
  o.cv.graphConnectFrom = null;
  o.render();
  return o.connect(from, id);
}

/** @param {{graphConnectFrom:string|null}} cv @param {()=>void} render */
export function cancelGraphConnection(cv, render) {
  if (!cv.graphConnectFrom) return false;
  cv.graphConnectFrom = null;
  render();
  return true;
}
