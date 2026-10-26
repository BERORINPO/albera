// @ts-check
// Roll back the visual previews for sheet and graph-card pointer gestures.

/** @param {{cv: {drag: {key:string}|null, graphDrag: {id:string}|null}, render:()=>void, world:()=>HTMLElement, sheetEl:(key:string)=>HTMLElement|null}} o */
export function createCanvasLayoutDragCancelActions(o) {
  return {
    cancelSheet(key) {
      o.sheetEl(key)?.classList.remove('is-dragging');
      if (o.cv.drag?.key === key) o.cv.drag = null;
      o.render();
    },
    cancelGraph(id) {
      o.world().querySelector(`.graph-node[data-id="${CSS.escape(id)}"]`)?.classList.remove('is-dragging');
      if (o.cv.graphDrag?.id === id) o.cv.graphDrag = null;
      o.render();
    },
  };
}
