import { $, api, copyText, el, formatBytes, formatDuration, state, viewer } from './core.js';
import { toast } from './toast.js';
import { renderCurate } from './curation.js';
import { afterEdit, load } from './grid.js';
import { DPR, fillPx, thumbUrl, tileUrl, viewerUrl } from './previews.js';
import { renderSuggestions } from './suggest.js';
import { applyTo, tagEditor } from './tags.js';
import { creatorOf, displayName, namingDefaults, titleRow } from './titles.js';
import { writeUrl } from './url.js';

// The asset viewer: media (photos, and videos with a Drive-player fallback), details, rights, navigation, zoom and related assets.

export function renderViewerLabel(asset) {
  $('d-name').textContent = displayName(asset);
  $('d-label').replaceChildren(...titleRow(asset, () => namingDefaults(asset, {
    media: asset.kind === 'video' ? 'Video' : 'Photo', date: asset.takenTime || asset.createdTime,
    width: asset.width, height: asset.height,
  }), { showTitle: false }));
}


// The add row stays open from photo to photo once opened, for tagging a run of them.
export const viewerUi = { addOpen: false };

export function renderViewerTags(asset) {
  const editor = tagEditor({
    tags: asset.tags,
    apply: applyTo([asset.id]),
    emptyText: 'No metadata yet. Dashed tags come from the folder.',
    collapsible: true,
    collapsed: !viewerUi.addOpen,
  });
  editor.onclose = () => { viewerUi.addOpen = false; };
  $('d-tags').replaceChildren(editor);
  $('d-add-tag').onclick = () => {
    viewerUi.addOpen = true;
    editor.openAdd();
  };
}

const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function folderLabel(ancestors, i) {
  return ancestors.slice(0, i + 1).map((f) => f.name).join(' / ');
}

export function renderRights(asset) {
  const r = asset.rights;
  const where = r.source.scope === 'file' ? 'set on this file'
    : r.source.scope === 'folder' ? `set on folder “${r.source.name}”`
      : 'default, no flag set';
  const current = $('r-current');
  current.className = `r-current ${r.status}`;
  // With no flag anywhere above it, nothing has been decided: say so, rather
  // than "cleared", which reads like an approval.
  current.textContent = (r.source.scope === 'default' ? 'No restriction recorded' : `${r.status === 'restricted' ? '⛔ Do not use' : '✓ Cleared'} (${where})`) +
    (r.note ? ` — ${r.note}` : '') +
    (r.updatedAt ? ` · ${new Date(r.updatedAt).toLocaleDateString()}` : '');

  for (const radio of document.getElementsByName('r-status')) radio.checked = radio.value === r.status;
  $('r-note').value = r.note || '';

  // Targets: this file, then each enclosing folder from nearest to the root.
  const target = $('r-target');
  target.replaceChildren(el('option', { value: asset.id, text: 'This file only' }));
  for (let i = asset.ancestors.length - 1; i >= 0; i--) {
    const f = asset.ancestors[i];
    target.append(el('option', { value: f.id, text: `Folder: ${folderLabel(asset.ancestors, i)}` }));
  }
  target.value = r.source.scope === 'folder' ? r.source.id : asset.id;
  // The note shown belongs to whichever item the flag is on; start blank for any other target.
  const flaggedId = r.source.scope === 'default' ? null : target.value;
  target.onchange = () => { $('r-note').value = target.value === flaggedId ? r.note : ''; };
  $('r-msg').textContent = '';
}

export async function saveRights(status) {
  const asset = state.current;
  const targetId = $('r-target').value;
  const isFolder = targetId !== asset.id;
  // The flag set on the file or folder itself before this change, for Undo.
  const before = isFolder ? state.folders.get(targetId)?.rights
    : asset.rights.source?.scope === 'file' ? asset.rights : null;
  const url = `/api/rights/${encodeURIComponent(targetId)}`;
  $('r-msg').textContent = 'Saving…';
  try {
    await api(url, { status, note: status === 'inherit' ? '' : $('r-note').value });
  } catch (err) {
    $('r-msg').textContent = `Could not save: ${err.message}`;
    return;
  }
  await afterEdit();
  $('r-msg').textContent = isFolder ? 'Saved for the whole folder.' : 'Saved.';
  const what = { restricted: 'Marked “Do not use”', cleared: 'Marked cleared to use', inherit: 'Removed the usage flag' }[status];
  toast(`${what}${isFolder ? ' for the whole folder' : ''}`, {
    undo: async () => {
      await api(url, before ? { status: before.status, note: before.note || '' } : { status: 'inherit' });
      await afterEdit();
    },
  });
}

// Videos play from the file itself when the browser can decode it; otherwise
// (H.265/HEVC, some MOVs: an error, or sound with no picture) they switch to
// Google Drive's own player, which streams any format Drive has processed but
// only for people who can open the file in Drive with their own account.
export function showVideo(asset, mode) {
  for (const [id, m] of [['p-direct', 'direct'], ['p-drive', 'drive']]) $(id).setAttribute('aria-pressed', String(mode === m));
  if (mode === 'drive') {
    $('stage').replaceChildren(el('iframe', {
      class: 'drive-player', src: `https://drive.google.com/file/d/${encodeURIComponent(asset.id)}/preview`,
      allow: 'autoplay; fullscreen', allowfullscreen: true, title: `${displayName(asset)} in Google Drive's player`,
    }));
    $('v-note').textContent = 'Google Drive’s player. Shows “You need access” if your account can’t open this file in Drive.';
    return;
  }
  const preview = asset.hasThumbnail ? viewerUrl(asset) : null;
  const video = el('video', {
    src: `/api/assets/${asset.id}/file`, controls: true, autoplay: true, playsinline: true, poster: preview, preload: 'metadata',
  });
  let switched = false;
  const fallback = () => {
    if (switched || state.current?.id !== asset.id) return;
    switched = true;
    showVideo(asset, 'drive');
    $('v-note').textContent = 'This browser can’t play this video’s format, so it’s in Google Drive’s player ' +
      '(needs access to the file in Drive).';
  };
  video.addEventListener('error', fallback);
  video.addEventListener('loadedmetadata', () => { if (!video.videoWidth) fallback(); });
  $('stage').replaceChildren(video);
  $('v-note').textContent = '';
}

// Shows the grid's preview (already loaded) straight away, then the sharp one;
// the original file if there's no preview or it fails.
export function photoElement(asset, preview, fileUrl) {
  const image = el('img', { src: preview ? tileUrl(asset) : fileUrl, alt: asset.name, class: preview ? 'soft' : '' });
  image.addEventListener('error', () => { if (image.getAttribute('src') !== fileUrl) image.src = fileUrl; });
  if (preview) {
    const sharp = new Image();
    sharp.onload = () => {
      if (state.current?.id !== asset.id) return;
      image.src = preview;
      image.classList.remove('soft');
      if (state.zoom) setZoom(state.zoom);
    };
    sharp.onerror = () => { if (state.current?.id === asset.id) image.src = fileUrl; };
    sharp.src = preview;
  }
  return image;
}

export function open(asset) {
  state.current = asset;
  const fileUrl = `/api/assets/${asset.id}/file`;
  // Photos show Drive's large preview (a JPG), which works for formats browsers
  // can't display (HEIC, RAW, TIFF, PSD) and loads faster than the original.
  // If there's no preview, fall back to the original file.
  const preview = asset.hasThumbnail ? viewerUrl(asset) : null;
  $('v-player').hidden = asset.kind !== 'video';
  $('v-note').textContent = '';
  if (asset.kind === 'video') showVideo(asset, 'direct');
  else $('stage').replaceChildren(photoElement(asset, preview, fileUrl));
  prefetchNeighbors(asset);
  renderViewerLabel(asset);
  renderCurate(asset);
  const rows = [
    ['Format', `${asset.format || ''} (${asset.mimeType})`.replace(/^ \(/, '(')],
    ['Size', formatBytes(asset.size)],
    ['Dimensions', asset.width ? `${asset.width} × ${asset.height}` : '—'],
    ...(asset.kind === 'video' ? [['Duration', formatDuration(asset.durationMs) || '—']] : []),
    ['Creator', creatorOf(asset) || '— (add one under Metadata)'],
    ['Folder', [asset.collection, asset.path].filter(Boolean).join(' / ')],
    ...(asset.takenTime ? [['Taken', when(asset.takenTime)]] : []),
    ...(asset.camera ? [['Camera', asset.camera]] : []),
    // Added to Drive only when there's no capture date; Modified only if it differs.
    ...(!asset.takenTime && asset.createdTime ? [['Added', when(asset.createdTime)]] : []),
    ...(asset.modifiedTime && when(asset.modifiedTime) !== when(asset.takenTime || asset.createdTime) ? [['Modified', when(asset.modifiedTime)]] : []),
  ];
  $('d-meta').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('d-download').href = `${fileUrl}?download=1`;
  $('d-drive').href = asset.webViewLink;
  $('d-copy').onclick = () => copyText($('d-copy'), location.href);
  renderSuggestions(asset);
  renderViewerTags(asset);
  renderRights(asset);
  setZoom(0);
  renderNav();
  renderRelated(asset);
  if (!viewer.open) viewer.showModal();
  writeUrl();
}


export const itemList = () => [...state.items.values()];
export const viewerIndex = () => itemList().findIndex((a) => a.id === state.current?.id);

// Loads the large previews either side of the open asset, so ← → is instant.
export function prefetchNeighbors(asset) {
  const list = itemList();
  const i = list.findIndex((a) => a.id === asset.id);
  if (i < 0) return;
  for (const a of [list[i + 1], list[i - 1], list[i + 2]]) {
    if (a?.hasThumbnail && a.kind !== 'video') new Image().src = viewerUrl(a);
  }
}

// Moves through the current results, loading the next page at the end.
export async function step(delta) {
  let list = itemList();
  const i = viewerIndex();
  if (i < 0) return;
  if (delta > 0 && i + 1 >= list.length && state.offset < state.total) {
    await load();
    list = itemList();
  }
  if (list[i + delta]) open(list[i + delta]);
}

export function renderNav() {
  const list = itemList();
  const i = viewerIndex();
  $('v-prev').disabled = i <= 0;
  $('v-next').disabled = i < 0 || (i >= list.length - 1 && state.offset >= state.total);
  $('v-pos').textContent = i >= 0 ? `${(i + 1).toLocaleString()} of ${state.total.toLocaleString()}` : '';
  const near = i >= 0 ? list.slice(Math.max(0, i - 7), i + 8) : [state.current];
  $('filmstrip').replaceChildren(...near.map((a) => {
    const ar = a.width && a.height ? Math.min(Math.max(a.width / a.height, 0.4), 3) : 1;
    return el('button', {
      type: 'button', class: a.id === state.current.id ? 'current' : '', style: `width: ${Math.round(52 * ar)}px`,
      'aria-label': `Show ${displayName(a)}`, 'aria-current': a.id === state.current.id ? 'true' : false,
      onclick: () => open(a),
    }, [a.hasThumbnail ? el('img', { src: thumbUrl(a, 52 * ar * DPR), alt: '', loading: 'lazy', decoding: 'async' }) : '']);
  }));
  $('filmstrip').querySelector('.current')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Zoom 0 = fit, 1 = 100% of the preview, 2 = 200%. Photos only.
export function setZoom(level) {
  const stage = $('stage');
  const img = stage.querySelector('img');
  const photo = state.current?.kind !== 'video' && img;
  if (!photo) level = 0;
  state.zoom = level;
  for (const [id, l] of [['z-fit', 0], ['z-100', 1], ['z-200', 2]]) {
    $(id).setAttribute('aria-pressed', String(level === l));
    $(id).disabled = !photo;
  }
  stage.classList.toggle('zoomed', level > 0);
  if (img) {
    img.style.width = level ? `${img.naturalWidth * level}px` : '';
    if (level) {
      const box = stage.getBoundingClientRect();
      stage.scrollLeft = (img.naturalWidth * level - box.width) / 2;
      stage.scrollTop = (img.naturalHeight * level - box.height) / 2;
    }
  }
}

export const relatedThumbs = (list) => (list.length
  ? list.map((a) => el('button', { type: 'button', title: displayName(a), 'aria-label': `Open ${displayName(a)}`, onclick: () => open(a) },
    [a.hasThumbnail ? el('img', { src: thumbUrl(a, fillPx(a, 120, 120)), alt: '', loading: 'lazy', decoding: 'async' }) : '']))
  : [el('p', { class: 'empty-note', text: 'Nothing else yet.' })]);

// "More from this shoot" (same folder) and "More like this" (visual or tag similarity).
export async function renderRelated(asset) {
  const id = asset.id;
  const parent = asset.ancestors[asset.ancestors.length - 1];
  $('d-shoot').replaceChildren();
  $('d-like').replaceChildren();
  $('d-shoot-all').hidden = !parent;
  const [shoot, like] = await Promise.all([
    parent ? api(`/api/assets?folder=${encodeURIComponent(parent.id)}&limit=7`).catch(() => null) : null,
    api(`/api/similar/${encodeURIComponent(id)}?limit=12`).catch(() => null),
  ]);
  if (state.current?.id !== id) return;
  const shootItems = (shoot?.items || []).filter((a) => a.id !== id).slice(0, 6);
  $('d-shoot').replaceChildren(...relatedThumbs(shootItems));
  if (shoot) $('d-shoot-all').textContent = `See all ${shoot.total.toLocaleString()}`;
  if (like) {
    $('d-like-title').textContent = like.mode === 'visual' ? 'More like this' : 'More like this (by tags)';
    const seen = new Set(shootItems.map((a) => a.id));
    $('d-like').replaceChildren(...relatedThumbs(like.items.filter((a) => !seen.has(a.id)).slice(0, 6)));
  }
}

