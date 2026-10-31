// background.js - Service Worker
// Detects media on each tab, probes it (quality / duration / size) and runs
// HLS → MP4 jobs through an offscreen document.

importScripts('lib/detector.js', 'lib/hls.js');

const mediaStore = {}; // tabId -> Map<url, item>
const jobs = new Map(); // url -> { jobId, status, done, total, error, filename }
const pendingBlobs = new Map(); // downloadId -> blobUrl
const cancelledJobs = new Set(); // jobIds

// ── Detection ───────────────────────────────────────────────────────────────

function updateBadge(tabId) {
  const count = visibleItems(tabId).length;
  chrome.action.setBadgeText({ text: count ? String(count) : '', tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId }).catch(() => {});
}

function addMedia(tabId, url, ctx) {
  if (tabId < 0) return;
  const info = Detector.classifyMedia(url, ctx);
  if (!info) return;
  if (!mediaStore[tabId]) mediaStore[tabId] = new Map();
  if (mediaStore[tabId].has(url)) return;

  const item = { url, kind: info.kind, ext: info.ext, timestamp: Date.now(), probe: { status: 'pending' } };
  mediaStore[tabId].set(url, item);
  updateBadge(tabId);
  probeItem(tabId, item);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function probeItem(tabId, item) {
  try {
    if (item.kind === 'hls') {
      const info = await HlsDownloader.probe(item.url, fetchText);
      item.probe = { status: 'ok', ...info };
    } else if (item.kind === 'file') {
      const res = await fetch(item.url, { method: 'HEAD' });
      const size = Number(res.headers.get('content-length')) || 0;
      item.probe = { status: res.ok ? 'ok' : 'failed', size };
    } else {
      item.probe = { status: 'ok' };
    }
  } catch (err) {
    item.probe = { status: 'failed', error: err.message };
  }
  updateBadge(tabId);
}

/**
 * What the popup shows: drop variant playlists that belong to a master
 * playlist we already list, and hide broken streams when working ones exist.
 */
function visibleItems(tabId) {
  const items = mediaStore[tabId] ? Array.from(mediaStore[tabId].values()) : [];
  const hasMaster = items.some(i => i.probe.kind === 'master');
  const children = new Set(items.flatMap(i => i.probe.childUrls || []));
  let visible = items.filter(i =>
    !children.has(i.url) && !(hasMaster && i.probe.kind === 'media'));

  const working = visible.filter(i => i.probe.status !== 'failed');
  if (working.length) visible = working;

  const rank = { hls: 0, file: 1, dash: 2 };
  return visible.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.timestamp - a.timestamp));
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => addMedia(details.tabId, details.url, { requestType: details.type }),
  { urls: ['<all_urls>'] }
);

// Catches streams whose URL has no extension but whose Content-Type gives them away.
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    const contentType = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
    if (/mpegurl|dash\+xml|^video\/|^audio\//i.test(contentType)) {
      addMedia(details.tabId, details.url, { requestType: details.type, contentType });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  delete mediaStore[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    delete mediaStore[tabId];
    updateBadge(tabId);
  }
});

// ── Offscreen document (does the heavy HLS work; survives the popup closing) ─

let creatingOffscreen = null;

function toOffscreen(msg) {
  chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Download HLS segments and assemble them into a single MP4 file',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function closeOffscreenIfIdle() {
  const busy = [...jobs.values()].some(j => j.status === 'preparing' || j.status === 'downloading' || j.status === 'converting');
  if (busy || pendingBlobs.size) return;
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) await chrome.offscreen.closeDocument().catch(() => {});
}

async function startHlsJob(url, filename, maxHeight) {
  const current = jobs.get(url);
  if (current && ['preparing', 'downloading', 'converting'].includes(current.status)) return;
  const jobId = crypto.randomUUID();
  jobs.set(url, { jobId, status: 'preparing', done: 0, total: 0, filename });
  await ensureOffscreen();
  toOffscreen({ type: 'HLS_START', jobId, url, filename, maxHeight });
}

function saveBlob(url, blobUrl, filename) {
  chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify' }, (downloadId) => {
    const job = jobs.get(url);
    if (chrome.runtime.lastError || downloadId === undefined) {
      if (job) Object.assign(job, { status: 'error', error: chrome.runtime.lastError?.message || 'Save failed' });
      toOffscreen({ type: 'REVOKE', blobUrl });
      closeOffscreenIfIdle();
      return;
    }
    pendingBlobs.set(downloadId, blobUrl);
    if (job) job.status = 'done';
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingBlobs.has(delta.id)) return;
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  toOffscreen({ type: 'REVOKE', blobUrl: pendingBlobs.get(delta.id) });
  pendingBlobs.delete(delta.id);
  closeOffscreenIfIdle();
});

// ── Messages ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // meant for the offscreen document

  switch (msg.type) {
    case 'GET_MEDIA': {
      const items = visibleItems(msg.tabId).map(i => ({ ...i, job: jobs.get(i.url) || null }));
      sendResponse({ items });
      return;
    }

    case 'CLEAR_MEDIA':
      delete mediaStore[msg.tabId];
      updateBadge(msg.tabId);
      sendResponse({ ok: true });
      return;

    case 'DOWNLOAD':
      chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify' }, (downloadId) => {
        if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        else sendResponse({ ok: true, downloadId });
      });
      return true;

    case 'DOWNLOAD_HLS':
      startHlsJob(msg.url, msg.filename)
        .then(() => sendResponse({ ok: true }))
        .catch(err => {
          jobs.set(msg.url, { status: 'error', error: err.message });
          sendResponse({ ok: false, error: err.message });
        });
      return true;

    case 'CANCEL_HLS': {
      const job = jobs.get(msg.url);
      if (job?.jobId) {
        cancelledJobs.add(job.jobId);
        toOffscreen({ type: 'HLS_CANCEL', jobId: job.jobId });
      }
      jobs.delete(msg.url);
      closeOffscreenIfIdle();
      sendResponse({ ok: true });
      return;
    }

    case 'DISMISS_JOB':
      jobs.delete(msg.url);
      sendResponse({ ok: true });
      return;

    // From the offscreen document
    case 'JOB_PROGRESS': {
      const job = jobs.get(msg.url);
      if (job && job.jobId === msg.jobId) Object.assign(job, { status: msg.phase, done: msg.done ?? job.done, total: msg.total ?? job.total });
      return;
    }

    case 'JOB_DONE': {
      const job = jobs.get(msg.url);
      if (cancelledJobs.has(msg.jobId) || (job && job.jobId !== msg.jobId)) {
        toOffscreen({ type: 'REVOKE', blobUrl: msg.blobUrl });
        closeOffscreenIfIdle();
        return;
      }
      // No job record means the service worker restarted mid-download — still save it.
      if (!job) jobs.set(msg.url, { jobId: msg.jobId, status: 'converting', filename: msg.filename });
      jobs.get(msg.url).status = 'saving';
      saveBlob(msg.url, msg.blobUrl, msg.filename);
      return;
    }

    case 'JOB_ERROR': {
      const job = jobs.get(msg.url);
      if (job && job.jobId === msg.jobId) Object.assign(job, { status: 'error', error: msg.error });
      closeOffscreenIfIdle();
      return;
    }

    case 'ADD_MEDIA': {
      // From content script — MUST use sender.tab.id, not msg.tabId
      const tabId = sender?.tab?.id;
      if (tabId) addMedia(tabId, msg.url, { requestType: 'element' });
      sendResponse({ ok: !!tabId });
      return;
    }
  }
});
