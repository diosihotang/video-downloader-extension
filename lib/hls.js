// lib/hls.js
// HLS (.m3u8) → MP4 downloader. Zero Chrome API dependencies — network access
// is injected (fetchText / fetchBytes) so it runs in the offscreen document,
// the service worker (probe only) and Node tests alike.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HlsDownloader = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseAttributes(str) {
    const attrs = {};
    for (const m of str.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
      attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    }
    return attrs;
  }

  function parseByteRange(value, prevEnd) {
    const [len, off] = value.split('@');
    const length = parseInt(len, 10);
    const offset = off !== undefined ? parseInt(off, 10) : prevEnd;
    return { offset: offset || 0, length };
  }

  /**
   * Parse an HLS playlist.
   * @param {string} text
   * @param {string} baseUrl  URL the playlist was fetched from (for relative URIs)
   * @returns {{type:'master', variants:object[], audio:object[]} |
   *           {type:'media', segments:object[], duration:number, endList:boolean}}
   */
  function parsePlaylist(text, baseUrl) {
    if (!/^﻿?\s*#EXTM3U/.test(text || '')) throw new Error('Not an HLS playlist');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const abs = uri => new URL(uri, baseUrl).href;

    if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const audio = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttributes(line.slice(18));
          const uri = lines.slice(i + 1).find(l => !l.startsWith('#'));
          if (!uri) continue;
          const [width, height] = (a.RESOLUTION || '').split('x').map(Number);
          variants.push({
            url: abs(uri),
            bandwidth: Number(a.BANDWIDTH) || 0,
            width: width || 0,
            height: height || 0,
            audioGroup: a.AUDIO || null,
          });
        } else if (line.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttributes(line.slice(13));
          if (a.TYPE === 'AUDIO') {
            audio.push({ groupId: a['GROUP-ID'], url: a.URI ? abs(a.URI) : null });
          }
        }
      }
      return { type: 'master', variants, audio };
    }

    const segments = [];
    let seq = 0;
    let key = null;
    let map = null;
    let duration = 0;
    let pendingDuration = 0;
    let pendingRange = null;
    let lastRangeEnd = 0;
    let endList = false;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = parseInt(line.slice(22), 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttributes(line.slice(11));
        if (!a.METHOD || a.METHOD === 'NONE') key = null;
        else if (a.METHOD === 'AES-128') key = { method: a.METHOD, url: abs(a.URI), iv: a.IV || null };
        else throw new Error(`Encrypted stream (${a.METHOD}/DRM) is not supported`);
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttributes(line.slice(11));
        map = { url: abs(a.URI), byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(line.slice(8)) || 0;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = parseByteRange(line.slice(17), lastRangeEnd);
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        endList = true;
      } else if (!line.startsWith('#')) {
        segments.push({ url: abs(line), duration: pendingDuration, seq, key, map, byteRange: pendingRange });
        if (pendingRange) lastRangeEnd = pendingRange.offset + pendingRange.length;
        duration += pendingDuration;
        seq++;
        pendingDuration = 0;
        pendingRange = null;
      }
    }
    return { type: 'media', segments, duration, endList };
  }

  // Optional cap on the picked resolution (set per download job; Infinity = no cap).
  let maxHeight = Infinity;
  function setMaxHeight(h) {
    maxHeight = h > 0 ? h : Infinity;
  }

  /** Highest resolution (within maxHeight), then highest bitrate. */
  function pickBestVariant(variants) {
    const allowed = variants.filter(v => !v.height || v.height <= maxHeight);
    if (allowed.length) {
      return [...allowed].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
    }
    // Every variant is above the cap — take the smallest one.
    return [...variants].sort((a, b) => (a.height - b.height) || (a.bandwidth - b.bandwidth))[0] || null;
  }

  /**
   * Resolve a (master or media) playlist URL down to the media playlist we'd download.
   * @returns {Promise<{kind:'master'|'media', variant:object|null, playlist:object, childUrls:string[]}>}
   */
  async function resolvePlaylist(url, fetchText) {
    const top = parsePlaylist(await fetchText(url), url);
    if (top.type === 'media') return { kind: 'media', variant: null, playlist: top, childUrls: [], audio: [] };

    const variant = pickBestVariant(top.variants);
    if (!variant) throw new Error('Playlist has no video variants');
    const playlist = parsePlaylist(await fetchText(variant.url), variant.url);
    if (playlist.type !== 'media') throw new Error('Unexpected nested master playlist');
    const childUrls = [...top.variants.map(v => v.url), ...top.audio.filter(a => a.url).map(a => a.url)];
    return { kind: 'master', variant, playlist, childUrls, audio: top.audio };
  }

  /** Lightweight info for the popup: quality + duration. */
  async function probe(url, fetchText) {
    const r = await resolvePlaylist(url, fetchText);
    return {
      kind: r.kind,
      height: r.variant ? r.variant.height : 0,
      duration: Math.round(r.playlist.duration),
      childUrls: r.childUrls,
    };
  }

  function hexToBytes(hex) {
    const clean = hex.replace(/^0x/i, '').padStart(32, '0');
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  function sequenceIv(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq);
    return iv;
  }

  async function decryptAes128(data, keyBytes, iv) {
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || require('crypto').webcrypto.subtle;
    const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, key, data));
  }

  function isTransportStream(bytes) {
    return bytes.length > 188 && bytes[0] === 0x47 && bytes[188] === 0x47;
  }

  async function withRetry(fn, signal, attempts = 3) {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (signal && signal.aborted) throw err;
        if (i >= attempts) throw err;
        await new Promise(r => setTimeout(r, 500 * i));
      }
    }
  }

  async function runPool(count, concurrency, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(concurrency, count) }, async () => {
      while (next < count) await worker(next++);
    });
    await Promise.all(runners);
  }

  /**
   * Fragmented-MP4 init segments often carry a placeholder duration (0 or
   * 0xFFFFFFFF), which makes desktop players show "13:15:21". Write the real
   * duration into mvhd / tkhd / mdhd / mehd in place.
   */
  function patchInitDuration(init, seconds) {
    const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
    const type = o => String.fromCharCode(init[o + 4], init[o + 5], init[o + 6], init[o + 7]);
    const writeDur = (o, is64, value) => {
      if (is64) { view.setUint32(o, Math.floor(value / 2 ** 32)); view.setUint32(o + 4, value >>> 0); }
      else view.setUint32(o, Math.min(value, 0xFFFFFFFE));
    };
    let movieTimescale = 1000;

    function walk(start, end) {
      for (let o = start; o + 8 <= end;) {
        const size = view.getUint32(o);
        if (size < 8 || o + size > end) return;
        const t = type(o);
        const body = o + 8;
        const v1 = init[body] === 1;
        if (t === 'moov' || t === 'trak' || t === 'mdia' || t === 'mvex') {
          walk(body, o + size);
        } else if (t === 'mvhd' || t === 'mdhd') {
          const tsOff = body + (v1 ? 20 : 12);
          const timescale = view.getUint32(tsOff);
          if (t === 'mvhd') movieTimescale = timescale;
          writeDur(tsOff + 4, v1, Math.round(seconds * timescale));
        } else if (t === 'tkhd') {
          writeDur(body + (v1 ? 28 : 20), v1, Math.round(seconds * movieTimescale));
        } else if (t === 'mehd') {
          writeDur(body + 4, v1, Math.round(seconds * movieTimescale));
        }
        o += size;
      }
    }
    walk(0, init.byteLength);
    return init;
  }

  /**
   * CMAF segments keep their original timestamps (a stream may start at 10s).
   * Rebase every track's tfdt so the file starts at 0, and neutralise sidx
   * boxes (each one only indexes its own segment and confuses seeking).
   */
  function rebaseFragments(parts) {
    const firstBase = new Map(); // trackId -> BigInt
    for (const bytes of parts) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const type = o => String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
      const walk = (start, end, trackId) => {
        for (let o = start; o + 8 <= end;) {
          const size = view.getUint32(o);
          if (size < 8 || o + size > end) return;
          const t = type(o);
          const body = o + 8;
          if (t === 'sidx') {
            bytes.set([0x66, 0x72, 0x65, 0x65], o + 4); // 'free'
          } else if (t === 'moof') {
            walk(body, o + size, null);
          } else if (t === 'traf') {
            const tfhd = (() => { for (let p = body; p + 8 <= o + size; p += view.getUint32(p)) { if (type(p) === 'tfhd') return p; if (view.getUint32(p) < 8) break; } return -1; })();
            walk(body, o + size, tfhd >= 0 ? view.getUint32(tfhd + 12) : 0);
          } else if (t === 'tfdt' && trackId !== null) {
            const v1 = bytes[body] === 1;
            const value = v1 ? view.getBigUint64(body + 4) : BigInt(view.getUint32(body + 4));
            if (!firstBase.has(trackId)) firstBase.set(trackId, value);
            const rebased = value - firstBase.get(trackId);
            const clamped = rebased < 0n ? 0n : rebased;
            if (v1) view.setBigUint64(body + 4, clamped);
            else view.setUint32(body + 4, Number(clamped));
          }
          o += size;
        }
      };
      walk(0, bytes.byteLength, null);
    }
  }

  /** MPEG-TS segments → one fragmented MP4 (audio + video combined). */
  function transmuxTs(segments, muxjs) {
    const transmuxer = new muxjs.mp4.Transmuxer();
    const parts = [];
    let initSegment = null;
    transmuxer.on('data', (seg) => {
      if (!initSegment) {
        initSegment = seg.initSegment;
        parts.push(initSegment);
      }
      parts.push(seg.data);
    });
    for (let i = 0; i < segments.length; i++) {
      transmuxer.push(segments[i]);
      transmuxer.flush();
      segments[i] = null; // free memory as we go
    }
    if (!initSegment) throw new Error('Conversion to MP4 produced no output');
    return parts;
  }

  /**
   * Download a full HLS stream and return it as MP4 bytes.
   * @param {string} url  master or media playlist
   * @param {object} opts
   * @param {(url:string)=>Promise<string>} opts.fetchText
   * @param {(url:string, byteRange:object|null)=>Promise<Uint8Array>} opts.fetchBytes
   * @param {object} opts.muxjs  mux.js module (needed for MPEG-TS streams)
   * @param {(p:{phase:string, done?:number, total?:number})=>void} [opts.onProgress]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.concurrency=6]
   * @returns {Promise<{parts:Uint8Array[], duration:number, height:number}>}
   */
  async function downloadHls(url, opts) {
    const { fetchText, fetchBytes, muxjs, signal, concurrency = 6 } = opts;
    const onProgress = opts.onProgress || (() => {});

    onProgress({ phase: 'preparing' });
    const { variant, playlist, audio } = await resolvePlaylist(url, fetchText);
    if (variant && variant.audioGroup && audio.some(a => a.groupId === variant.audioGroup && a.url)) {
      throw new Error('Streams with a separate audio track are not supported yet');
    }
    if (!playlist.endList) throw new Error('Live streams are not supported');
    const segs = playlist.segments;
    if (!segs.length) throw new Error('Playlist has no segments');

    const keyCache = new Map();
    const getKey = (k) => {
      if (!keyCache.has(k.url)) keyCache.set(k.url, withRetry(() => fetchBytes(k.url, null), signal));
      return keyCache.get(k.url);
    };

    const data = new Array(segs.length);
    let done = 0;
    onProgress({ phase: 'downloading', done, total: segs.length });
    await runPool(segs.length, concurrency, async (i) => {
      if (signal && signal.aborted) throw new Error('Cancelled');
      const seg = segs[i];
      let bytes = await withRetry(() => fetchBytes(seg.url, seg.byteRange), signal);
      if (seg.key) {
        const iv = seg.key.iv ? hexToBytes(seg.key.iv) : sequenceIv(seg.seq);
        bytes = await decryptAes128(bytes, await getKey(seg.key), iv);
      }
      data[i] = bytes;
      onProgress({ phase: 'downloading', done: ++done, total: segs.length });
    });

    let parts;
    if (isTransportStream(data[0])) {
      if (!muxjs) throw new Error('mux.js is required to convert MPEG-TS streams');
      onProgress({ phase: 'converting' });
      parts = transmuxTs(data, muxjs);
    } else {
      // Fragmented MP4 (CMAF): init segment + media segments concatenated is a valid MP4.
      parts = [];
      let lastMap = null;
      for (let i = 0; i < segs.length; i++) {
        const map = segs[i].map;
        if (map && (!lastMap || map.url !== lastMap.url)) {
          parts.push(await withRetry(() => fetchBytes(map.url, map.byteRange), signal));
          lastMap = map;
        }
        parts.push(data[i]);
      }
      rebaseFragments(data);
    }
    patchInitDuration(parts[0], playlist.duration);

    return { parts, duration: playlist.duration, height: variant ? variant.height : 0 };
  }

  return { parsePlaylist, pickBestVariant, setMaxHeight, resolvePlaylist, probe, downloadHls, isTransportStream, patchInitDuration };
});
