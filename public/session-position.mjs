import { CANVAS } from '../src/shared/constants.mjs';

const { SLIP_W, SLIP_H } = CANVAS;

/** @param {any} layout @param {string} id */
export function defaultSessionRect(layout, id) {
  for (const sheet of layout?.sheets ?? []) {
    const slip = sheet.slips.find((item) => item.id === id);
    if (slip) return { x: sheet.x + slip.x, y: sheet.y + slip.y, w: SLIP_W, h: slip.h ?? SLIP_H };
  }
  return null;
}

/** @param {any} layout @param {string} id @param {Record<string,{x:number,y:number}>} positions @param {{id:string,x:number,y:number}|null} [drag] */
export function sessionRect(layout, id, positions = {}, drag = null) {
  const origin = defaultSessionRect(layout, id);
  if (!origin) return null;
  const custom = drag?.id === id ? drag : positions?.[id];
  return custom ? { ...origin, x: custom.x, y: custom.y } : origin;
}

/** @param {string} id @param {Record<string,{card:any,pile:string}>} index @param {Record<string,{x:number,y:number}>} positions @param {{id:string,x:number,y:number}|null} [drag] */
export function isPositionedSession(id, index, positions = {}, drag = null) {
  return index.has(id) && (drag?.id === id || Object.hasOwn(positions ?? {}, id));
}
