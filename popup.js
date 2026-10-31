// popup.js

let currentTab = null;
let lastSignature = '';

const ACTIVE = ['preparing', 'downloading', 'converting', 'saving'];

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
}

function fileNameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last);
  } catch { return ''; }
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : m;
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function showToast(msg) {
  document.querySelector('.toast')?.remove();
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// ── Per-item text ───────────────────────────────────────────────────────────

function titleFor(item) {
  if (item.kind === 'file') return fileNameFromUrl(item.url) || currentTab.title || 'Video file';
  return currentTab.title || fileNameFromUrl(item.url) || 'Video stream';
}

function metaFor(item) {
  const p = item.probe || {};
  if (p.status === 'pending') return 'Checking…';
  if (item.kind === 'dash') return 'DASH stream · not supported yet';
  if (item.kind === 'file') {
    return [item.ext.toUpperCase() + ' file', formatBytes(p.size)].filter(Boolean).join(' · ');
  }
  if (p.status === 'failed') return 'Stream · could not read playlist';
  return ['Stream', p.height ? p.height + 'p' : '', formatDuration(p.duration)].filter(Boolean).join(' · ');
}

function downloadFilename(item) {
  if (item.kind === 'file') {
    const fromUrl = fileNameFromUrl(item.url);
    return sanitizeFilename(/\.\w{2,4}$/.test(fromUrl) ? fromUrl : `${titleFor(item)}.${item.ext}`);
  }
  return sanitizeFilename(titleFor(item)) + '.mp4';
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function download(item) {
  if (item.kind === 'hls') {
    const resp = await send({ type: 'DOWNLOAD_HLS', url: item.url, filename: downloadFilename(item) });
    if (!resp?.ok) showToast('Failed: ' + (resp?.error || 'unknown error'));
  } else {
    const resp = await send({ type: 'DOWNLOAD', url: item.url, filename: downloadFilename(item) });
    showToast(resp?.ok ? 'Download started' : 'Failed: ' + (resp?.error || 'unknown error'));
  }
  refresh();
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderProgress(item) {
  const job = item.job;
  const wrap = el('div', 'progress');
  const row = el('div', 'progress-row');
  const track = el('div', 'progress-track');
  const fill = el('div', 'progress-fill');
  track.appendChild(fill);

  let label = 'Preparing…';
  if (job.status === 'downloading' && job.total) {
    const pct = Math.round((job.done / job.total) * 100);
    label = `Downloading ${pct}% (${job.done}/${job.total})`;
    fill.style.width = pct + '%';
  } else {
    if (job.status === 'converting') label = 'Converting to MP4…';
    if (job.status === 'saving') label = 'Saving…';
    fill.classList.add('indeterminate');
  }

  const cancel = el('button', 'btn-ghost', 'Cancel');
  cancel.addEventListener('click', async () => {
    await send({ type: 'CANCEL_HLS', url: item.url });
    refresh();
  });

  row.append(el('span', '', label), cancel);
  wrap.append(row, track);
  return wrap;
}

function renderCard(item) {
  const card = el('div', 'card');
  card.append(el('div', 'card-title', titleFor(item)), el('div', 'card-meta', metaFor(item)));
  card.querySelector('.card-title').title = item.url;

  const job = item.job;
  if (job && ACTIVE.includes(job.status)) {
    card.appendChild(renderProgress(item));
    return card;
  }

  if (job?.status === 'done') {
    const done = el('div', 'progress-row');
    const show = el('button', 'btn-ghost', 'Show file');
    show.addEventListener('click', () => chrome.downloads.showDefaultFolder());
    done.append(el('span', 'status-done', '✓ Saved to Downloads'), show);
    done.style.marginTop = '10px';
    card.appendChild(done);
  }
  if (job?.status === 'error') {
    const err = el('div', 'status-error', '⚠ ' + job.error);
    err.style.marginTop = '10px';
    card.appendChild(err);
  }

  const actions = el('div', 'card-actions');
  const primary = el('button', 'btn-primary');
  if (item.kind === 'dash') {
    primary.textContent = 'Not supported';
    primary.disabled = true;
  } else {
    primary.textContent = job?.status === 'error' ? 'Try again'
      : job?.status === 'done' ? 'Download again'
      : item.kind === 'hls' ? 'Download MP4' : 'Download';
    primary.addEventListener('click', () => download(item));
  }

  const copy = el('button', 'btn-secondary', 'Copy URL');
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(item.url).then(() => showToast('URL copied'));
  });

  actions.append(primary, copy);
  card.appendChild(actions);
  return card;
}

function render(items) {
  // Re-render only when something changed, so hover/focus isn't reset every tick.
  const signature = JSON.stringify(items.map(i => [i.url, i.probe, i.job]));
  if (signature === lastSignature) return;
  lastSignature = signature;

  const list = document.getElementById('media-list');
  list.replaceChildren(...items.map(renderCard));
  document.getElementById('empty-state').hidden = items.length > 0;
}

async function refresh() {
  if (!currentTab) return;
  const resp = await send({ type: 'GET_MEDIA', tabId: currentTab.id });
  render(resp?.items || []);
}

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!currentTab) return;

  const hostEl = document.getElementById('page-host');
  try { hostEl.textContent = new URL(currentTab.url).hostname; } catch { hostEl.textContent = ''; }

  document.getElementById('btn-clear').addEventListener('click', async () => {
    await send({ type: 'CLEAR_MEDIA', tabId: currentTab.id });
    refresh();
  });

  await refresh();
  setInterval(refresh, 1000);
});
