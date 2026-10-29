import { $, state, viewer } from './core.js';
import { step } from './viewer.js';

// Phones: the viewer's details are a bottom sheet (tap the handle or the
// peeking name, or swipe up, to open; swipe down to close), and swiping
// left/right on the photo moves to the next or previous one.

const layout = () => viewer.querySelector('.viewer');

export function setSheet(open) {
  layout().classList.toggle('sheet-open', open);
  $('sheet-toggle').setAttribute('aria-expanded', String(open));
  $('sheet-toggle').setAttribute('aria-label', open ? 'Hide details' : 'Show details');
  if (!open) $('details').scrollTop = 0;
}
const sheetOpen = () => layout().classList.contains('sheet-open');

$('sheet-toggle').addEventListener('click', () => setSheet(!sheetOpen()));
// A tap on the peeking part (name, title) opens the sheet; its buttons still work.
$('details').addEventListener('click', (e) => {
  if (!sheetOpen() && matchMedia('(max-width: 720px)').matches && !e.target.closest('button, a, input, select, textarea, label')) setSheet(true);
});
viewer.addEventListener('close', () => setSheet(false));

// Calls `onSwipe(dx, dy)` for a one-finger swipe on `target`.
function swipes(target, onSwipe) {
  let start = null;
  target.addEventListener('touchstart', (e) => {
    start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  target.addEventListener('touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    start = null;
    onSwipe(dx, dy);
  }, { passive: true });
}

const horizontal = (dx, dy) => Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy);
const vertical = (dx, dy) => Math.abs(dy) > 60 && Math.abs(dy) > 1.5 * Math.abs(dx);

swipes($('stage'), (dx, dy) => {
  if (state.zoom) return; // dragging pans a zoomed photo
  if (horizontal(dx, dy)) step(dx < 0 ? 1 : -1);
  else if (vertical(dx, dy) && dy < 0) setSheet(true);
});
swipes($('details'), (dx, dy) => {
  if (!vertical(dx, dy)) return;
  if (dy < 0 && !sheetOpen()) setSheet(true);
  else if (dy > 0 && sheetOpen() && $('details').scrollTop <= 0) setSheet(false);
});
