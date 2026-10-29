import { $, api, el, grid, state } from './core.js';
import { loadFolders, renderFolderPanel } from './folders.js';
import { afterEdit, card, load, reloadInPlace } from './grid.js';
import { renderBulk } from './selection.js';

// Tag suggestions from Claude: progress, review boxes, accepting and dismissing.

export async function refreshAi() {
  clearTimeout(refreshAi.timer);
  try {
    state.ai = await api('/api/suggest/status');
  } catch {
    state.ai = { enabled: false };
  }
  const ai = state.ai;
  $('suggested-field').hidden = !ai.enabled && !state.suggested;
  const active = (ai.queued || 0) + (ai.running || 0) > 0 || Boolean(ai.preparing);
  const batches = ai.batches || [];
  const busy = active || batches.length > 0;
  const bar = $('ai-status');
  const cost = ai.costUsd != null ? ` · ≈ $${ai.costUsd.toFixed(2)} so far` : '';
  const stop = el('button', { type: 'button', class: 'link', text: 'Stop', onclick: async () => {
    if (!confirm('Stop suggesting tags? Photos already done keep their suggestions.')) return;
    await api('/api/suggest/cancel', {});
    refreshAi();
  } });
  if (busy) {
    const lines = [];
    if (ai.preparing) lines.push(`Preparing a batch: ${ai.preparing.done} of ${ai.preparing.total} previews`);
    if ((ai.queued || 0) + (ai.running || 0)) lines.push(`Claude is suggesting tags: ${ai.queued + ai.running} to go`);
    for (const b of batches) {
      const done = (b.succeeded || 0) + (b.errored || 0);
      lines.push(`Batch of ${b.count} photos sent ${new Date(b.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` +
        ` (half price${done ? `, ${done} done` : ''}). Results usually arrive within an hour; you can close this page`);
    }
    bar.hidden = false;
    bar.replaceChildren(el('span', { text: `✨ ${lines.join(' · ')}${cost}` }), stop);
    // Show new results as they come in; batches change slowly, so check them less often.
    if (active && ++refreshAi.ticks % 4 === 0) reloadInPlace();
    refreshAi.timer = setTimeout(refreshAi, active ? 3000 : 30000);
  } else if (state.aiWasBusy) {
    bar.hidden = !(ai.done || ai.failed);
    bar.replaceChildren(
      el('span', { text: `✨ Done: ${ai.done} suggested${ai.failed ? `, ${ai.failed} failed (${ai.lastError})` : ''}${cost}.` }),
      el('button', { type: 'button', class: 'link', text: 'Review suggestions', onclick: () => {
        state.suggested = 'pending';
        $('suggested').value = 'pending';
        $('suggested-field').hidden = false;
        load(true);
      } }),
      el('button', { type: 'button', class: 'link', text: 'Hide', onclick: () => { bar.hidden = true; } }),
    );
    reloadInPlace();
    loadFolders();
  }
  state.aiWasBusy = busy;
  renderFolderPanel({ background: true });
  renderBulk();
}

refreshAi.ticks = 0;

export async function queueSuggestions(body, count) {
  const each = state.ai.estimatePerImage;
  const batch = count > (state.ai.batchMin ?? 50);
  const total = each ? each * count * (batch ? 0.5 : 1) : null;
  const estimate = total != null ? ` Estimated cost: about $${total < 0.01 ? total.toFixed(3) : total.toFixed(2)}.` : '';
  const how = batch
    ? 'More than 50 photos run as a batch at half price. Results usually arrive within an hour (at most 24 hours), and you can close this page meanwhile.'
    : 'They run right away.';
  if (!confirm(`Ask Claude to suggest tags for up to ${count.toLocaleString()} photos?${estimate}\n\n${how}\n\nPhotos that already have suggestions are skipped. You review everything before it becomes a tag.`)) return;
  try {
    const res = await api('/api/suggest', body);
    if (!res.added) alert('Nothing to do: these photos already have suggestions (or have no preview).');
    state.aiWasBusy = state.aiWasBusy || res.added > 0;
  } catch (err) {
    alert(err.message);
  }
  refreshAi();
}

export const accept = async (body) => { await api('/api/suggest/accept', body); await afterEdit(); };
export const dismiss = async (body) => { await api('/api/suggest/dismiss', body); await afterEdit(); };

// Claude's suggestions for an asset or a folder: accept/dismiss each value,
// accept or dismiss all, or ask (again). `run()` makes the request and redraws.
export function suggestionBox({ id, s, run, runLabel = 'Suggest tags', title = '✨ Suggested by Claude' }) {
  const runButton = (label) => el('button', {
    class: 'btn ghost', type: 'button', text: label,
    onclick: async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Asking Claude…';
      try {
        await run();
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = err.message;
      }
    },
  });
  const parts = [el('div', { class: 'suggest-head' }, [el('span', { text: title })])];
  if (!s) {
    parts.push(el('div', { class: 'row-actions' }, [runButton(runLabel)]));
  } else if (s.error) {
    parts.push(el('p', { class: 'err', text: s.error }));
    if (state.ai.enabled) parts.push(el('div', { class: 'row-actions' }, [runButton('Try again')]));
  } else {
    if (s.description) parts.push(el('p', { class: 'desc', text: s.description }));
    const rows = state.fields.filter((f) => s.pending[f.key]?.length).map((f) => el('div', { class: 'field-row' }, [
      el('span', { text: f.label }),
      el('div', { class: 'chips' }, s.pending[f.key].map((value) => el('span', { class: 'chip suggested' }, [
        value,
        el('button', { type: 'button', class: 'ok', title: 'Accept', 'aria-label': `Accept ${value}`, text: '✓',
          onclick: () => accept({ ids: [id], field: f.key, value }) }),
        el('button', { type: 'button', title: 'Dismiss', 'aria-label': `Dismiss ${value}`, text: '×',
          onclick: () => dismiss({ id, field: f.key, value }) }),
      ]))),
    ]));
    parts.push(...(rows.length ? rows : [el('p', { class: 'empty-note', text: 'All suggestions reviewed.' })]));
    parts.push(el('div', { class: 'row-actions' }, [
      s.count ? el('button', { class: 'btn', type: 'button', text: 'Accept all', onclick: () => accept({ ids: [id] }) }) : '',
      s.count ? el('button', { class: 'btn ghost', type: 'button', text: 'Dismiss all', onclick: () => dismiss({ ids: [id] }) }) : '',
      state.ai.enabled ? runButton('Ask again') : '',
    ]));
  }
  return el('div', { class: 'suggest' }, parts);
}

// Claude's suggestions for the open asset take space only while some are left
// to review (or failed); asking (again) is a link beside the Metadata heading.
export function renderSuggestions(asset) {
  const box = $('d-suggest');
  const s = asset.suggestions;
  const run = async () => {
    const fresh = await api(`/api/suggest/${asset.id}/run`, {});
    state.current = fresh;
    state.items.set(fresh.id, fresh);
    grid.querySelector(`[data-id="${CSS.escape(fresh.id)}"]`)?.replaceWith(card(fresh));
    renderSuggestions(fresh);
    refreshAi();
  };
  box.replaceChildren(s && (s.count || s.error) ? suggestionBox({ id: asset.id, s, run }) : '');
  const ask = $('d-ask');
  ask.hidden = !state.ai.enabled;
  ask.disabled = false;
  ask.textContent = s ? '✨ Ask Claude again' : '✨ Suggest tags';
  ask.onclick = async () => {
    ask.disabled = true;
    ask.textContent = 'Asking Claude…';
    try {
      await run();
    } catch (err) {
      ask.disabled = false;
      ask.textContent = err.message;
    }
  };
}

