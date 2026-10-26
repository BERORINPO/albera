import assert from 'node:assert/strict';
import test from 'node:test';
import { nextCanvasGraphPosition } from '../public/canvas-graph-position-act.mjs';

test('canvas graph placement passes card dimensions and avoids project sheets', () => {
  const cv = {
    cam: { x: -64.51612903225806, y: -154.83870967741936, z: 0.62 },
    layout: {
      sheets: [
        { x: 0, y: 0, w: 1728, h: 500 },
        { x: 0, y: 620, w: 864, h: 348 },
        { x: 960, y: 620, w: 864, h: 368 },
        { x: 0, y: 1108, w: 432, h: 52 },
        { x: 528, y: 1108, w: 432, h: 52 },
      ],
      fold: null,
    },
  };
  const position = nextCanvasGraphPosition(cv, () => ({ w: 1280, h: 500 }), { v: 1, nodes: [], edges: [] });
  assert.deepEqual(position, { x: 220, y: -220 });
});
