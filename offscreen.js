// offscreen.js
// Runs HLS → MP4 jobs. Lives in an offscreen document so downloads keep going
// after the popup closes, and so we can hand a Blob URL to chrome.downloads.

const controllers = new Map(); // jobId -> AbortController

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'HLS_START') runJob(msg);
  if (msg.type === 'HLS_CANCEL') controllers.get(msg.jobId)?.abort();
  if (msg.type === 'REVOKE') URL.revokeObjectURL(msg.blobUrl);
});

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function runJob({ jobId, url, filename, maxHeight }) {
  HlsDownloader.setMaxHeight(maxHeight);
  const controller = new AbortController();
  const { signal } = controller;
  controllers.set(jobId, controller);

  const fetchText = async (u) => {
    const res = await fetch(u, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} while loading playlist`);
    return res.text();
  };
  const fetchBytes = async (u, range) => {
    const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
    const res = await fetch(u, { signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} while downloading segment`);
    return new Uint8Array(await res.arrayBuffer());
  };

  // Throttle progress messages — a long video has hundreds of segments.
  let lastSent = 0;
  const onProgress = (p) => {
    const now = Date.now();
    if (p.phase === 'downloading' && p.done < p.total && now - lastSent < 250) return;
    lastSent = now;
    send({ type: 'JOB_PROGRESS', jobId, url, ...p });
  };

  try {
    const result = await HlsDownloader.downloadHls(url, { fetchText, fetchBytes, muxjs, onProgress, signal });
    const blobUrl = URL.createObjectURL(new Blob(result.parts, { type: 'video/mp4' }));
    send({ type: 'JOB_DONE', jobId, url, filename, blobUrl });
  } catch (err) {
    if (!signal.aborted) send({ type: 'JOB_ERROR', jobId, url, error: err.message || String(err) });
  } finally {
    controllers.delete(jobId);
  }
}
