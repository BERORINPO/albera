// Write the map into the HTML template. The map goes in as JSON inside <script type="application/json">;
// the page draws it with DOM APIs, so no data is ever turned into HTML text here.
import { fileURLToPath } from 'node:url';
import { validateMap } from '../shared/map-shape.mjs';

export const TEMPLATE_PATH = fileURLToPath(new URL('./template.html', import.meta.url));
export const DATA_SLOT = '<!--MOCHIBA_DATA-->';
export const SCRIPT_SLOT = '/*MOCHIBA_PAGE_JS*/';
/** The page scripts, joined in this order into the one <script> of the template (they share one scope). */
export const PAGE_SCRIPTS = ['ego.js', 'map.js', 'story.js', 'grade.js', 'quiz.js', 'start.js'].map((name) => fileURLToPath(new URL(`./page/${name}`, import.meta.url)));

/** JSON that is safe inside a <script> element (no "</script>", no "<!--", no line separators). */
export function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const once = (text, slot, what) => {
  const parts = text.split(slot);
  if (parts.length !== 2) throw new Error(`${what} must contain ${slot} exactly once`);
  return parts;
};

/** The template with the page scripts put in. Page code must not be able to end its own <script>. */
export function assemblePage(template, scripts) {
  // One directive at the very top makes every page file strict, whatever file comes first.
  const js = `'use strict';\n${scripts.join('\n')}`;
  if (/<\/script|<!--/i.test(js)) throw new Error('page scripts must not contain "</script" or "<!--"');
  const [before, after] = once(template, SCRIPT_SLOT, 'template');
  return before + js + after;
}

export function renderHtml(template, map) {
  const errors = validateMap(map);
  if (errors.length) throw new Error(`map is not valid: ${errors.slice(0, 5).join('; ')}`);
  const [before, after] = once(template, DATA_SLOT, 'template');
  return before + embedJson(map) + after;
}
