// lib/detector.js
// Pure logic — zero Chrome API dependencies. Fully testable.

'use strict';

const MEDIA_PATTERNS = [
  /\.(mp4|webm|mkv|avi|mov|flv|wmv|m4v|3gp|ogv)(\?|$)/i,
  /\.(mp3|aac|ogg|flac|wav|m4a|opus)(\?|$)/i,
  /\.(m3u8|mpd)(\?|$)/i,
  /\.ts(\?|$)/i,
  /\.googlevideo\.com/i,
  /stream\.mux\.com/i,
  /muxedge\.com/i,
  /cdn\.jwplayer\.com/i,
  /brightcove\.net.*\.(mp4|m3u8)/i,
  /akamaihd\.net.*\.(mp4|m3u8)/i,
  /cloudfront\.net.*\.(mp4|webm|m3u8)/i,
  /fastly\.net.*\.(mp4|webm|m3u8)/i,
  /vimeocdn\.com/i,
  /vimeo\.com\/external/i,
  /videoplayback/i,
  /manifest\.m3u8/i,
  /\/hls\//i,
  /\/dash\//i,
  /video-downloads/i,
];

const BLOCKED_PATTERNS = [
  /\.(js|css|html|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json|xml|txt|pdf)(\?|$)/i,
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /doubleclick\.net/i,
  /facebook\.com\/tr/i,
  /connect\.facebook\.net/i,
  /hotjar\.com/i,
  /segment\.com\/v1/i,
  /mixpanel\.com/i,
];

/**
 * Returns true if the URL looks like a media resource.
 * @param {string} url
 * @returns {boolean}
 */
function isMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (BLOCKED_PATTERNS.some(p => p.test(url))) return false;
  return MEDIA_PATTERNS.some(p => p.test(url));
}

/**
 * Returns the media type category.
 * @param {string} url
 * @returns {'video'|'audio'|'hls/dash'|'media'}
 */
function getMediaType(url) {
  if (/\.(mp3|aac|ogg|flac|wav|m4a|opus)(\?|$)/i.test(url)) return 'audio';
  if (/\.(m3u8|mpd|ts)(\?|$)/i.test(url)) return 'hls/dash';
  if (/stream\.mux\.com/i.test(url)) return 'hls/dash';
  if (/manifest\.m3u8/i.test(url)) return 'hls/dash';
  if (/\/hls\//i.test(url)) return 'hls/dash';
  if (/videoplayback|googlevideo/i.test(url)) return 'video';
  if (/vimeocdn\.com/i.test(url)) return 'video';
  return 'video';
}

/**
 * Returns the best-guess file extension for a URL.
 * @param {string} url
 * @returns {string}
 */
function getExtension(url) {
  const match = url.match(/\.(mp4|webm|mkv|mp3|aac|ogg|m3u8|mpd|m4a|wav|flac|ts)(\?|$)/i);
  if (match) return match[1].toLowerCase();
  if (/googlevideo|videoplayback/i.test(url)) return 'mp4';
  if (/stream\.mux\.com/i.test(url)) return 'm3u8';
  if (/vimeocdn\.com/i.test(url)) return 'mp4';
  return 'mp4';
}

/**
 * Extract a filename from a URL + optional page title.
 * @param {string} url
 * @param {string} [title]
 * @returns {string}
 */
function getFilename(url, title) {
  const ext = getExtension(url);
  if (title) {
    return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) + '.' + ext;
  }
  try {
    const u = new URL(url);
    const part = u.pathname.split('/').filter(Boolean).pop() || '';
    if (part && /\.\w{2,5}$/.test(part)) return part.split('?')[0];
  } catch {}
  return `video_download.${ext}`;
}

/**
 * Scan inline script text for media URLs.
 * Returns array of found URLs.
 * @param {string} text
 * @returns {string[]}
 */
function extractUrlsFromScriptText(text) {
  if (!text) return [];
  const found = new Set();

  // stream.mux.com
  for (const m of text.matchAll(/https:\/\/stream\.mux\.com\/[a-zA-Z0-9_-]+(?:\.m3u8)?[^\s"'\\]*/g)) {
    found.add(m[0]);
  }
  // Mux playbackId key
  for (const m of text.matchAll(/"playbackId"\s*:\s*"([a-zA-Z0-9_-]+)"/g)) {
    found.add(`https://stream.mux.com/${m[1]}.m3u8`);
  }
  // Any .m3u8
  for (const m of text.matchAll(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/g)) {
    found.add(m[0]);
  }
  // Any .mp4
  for (const m of text.matchAll(/https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*/g)) {
    found.add(m[0]);
  }

  return Array.from(found);
}

/**
 * Recursively extract media URLs from a JSON-LD object.
 * @param {*} data
 * @returns {string[]}
 */
function extractUrlsFromJsonLD(data) {
  const found = [];
  function walk(node) {
    if (!node) return;
    if (typeof node === 'string') {
      if (isMediaUrl(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') { Object.values(node).forEach(walk); }
  }
  walk(data);
  return found;
}

const HLS_URL = /\.m3u8(\?|$)/i;
const DASH_URL = /\.mpd(\?|$)/i;
// Pieces of a stream, never a whole video on their own.
const SEGMENT_URL = /\.(ts|m4s|cmfv|cmfa|m4f)(\?|$)/i;
const FILE_URL = /\.(mp4|webm|mkv|mov|m4v|avi|flv|ogv|3gp|mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i;

/**
 * Decide whether a request is something worth offering for download.
 *
 * Streaming players fetch fragmented-MP4 segments (often named *.mp4) with
 * XHR/fetch — downloading one of those yields a few seconds of video. A real
 * standalone file is loaded by a <video> element, a link, or found in markup.
 *
 * @param {string} url
 * @param {{requestType?:string, contentType?:string}} [ctx]
 *   requestType: webRequest `details.type`, or 'element' when reported by the content script
 * @returns {{kind:'hls'|'dash'|'file', ext:string}|null}
 */
function classifyMedia(url, ctx = {}) {
  if (!url || typeof url !== 'string' || !/^https?:/i.test(url)) return null;
  const requestType = ctx.requestType || '';
  const contentType = ctx.contentType || '';

  if (HLS_URL.test(url) || /mpegurl/i.test(contentType)) return { kind: 'hls', ext: 'm3u8' };
  if (DASH_URL.test(url) || /dash\+xml/i.test(contentType)) return { kind: 'dash', ext: 'mpd' };
  if (BLOCKED_PATTERNS.some(p => p.test(url))) return null;
  if (SEGMENT_URL.test(url)) return null;
  if (requestType === 'xmlhttprequest' || requestType === 'fetch') return null;

  const m = url.match(FILE_URL);
  if (m) return { kind: 'file', ext: m[1].toLowerCase() };
  if (requestType === 'media' && /^(video|audio)\//i.test(contentType)) {
    return { kind: 'file', ext: /audio/i.test(contentType) ? 'mp3' : 'mp4' };
  }
  return null;
}

const api = {
  classifyMedia,
  isMediaUrl,
  getMediaType,
  getExtension,
  getFilename,
  extractUrlsFromScriptText,
  extractUrlsFromJsonLD,
  MEDIA_PATTERNS,
  BLOCKED_PATTERNS,
};

// CommonJS for tests, global for the service worker (importScripts).
if (typeof module === 'object' && module.exports) module.exports = api;
else self.Detector = api;
