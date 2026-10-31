// content.js
// Runs in the ISOLATED world — cannot directly patch page's fetch/XHR.
// We inject an inline script into the PAGE world to intercept those,
// then receive results via window.postMessage.

(function () {
  'use strict';

  // ── 1. Inject page-world interceptor script ──────────────────────────────
  const script = document.createElement('script');
  script.textContent = `(function () {
    const MEDIA_EXT = /\\.(mp4|webm|mkv|avi|mov|flv|m4v|3gp|ogv|mp3|aac|ogg|flac|wav|m4a|opus|m3u8|mpd|ts)(\\?|$)/i;
    const MEDIA_DOMAINS = ['stream.mux.com','muxedge.com','vimeocdn.com','googlevideo.com',
      'akamaihd.net','cdn.jwplayer.com','brightcove.net','cloudfront.net','fastly.net'];

    function isMuxDomain(url) {
      try {
        const h = new URL(url, location.href).hostname;
        return MEDIA_DOMAINS.some(d => h === d || h.endsWith('.' + d));
      } catch { return false; }
    }

    function isMedia(url) {
      if (!url || typeof url !== 'string') return false;
      if (url.startsWith('blob:') || url.startsWith('data:')) return false;
      return MEDIA_EXT.test(url) || isMuxDomain(url);
    }

    const MANIFEST_EXT = /\.(m3u8|mpd)(\?|$)/i;

    function emit(url, fromNetwork) {
      try {
        const abs = new URL(url, location.href).href;
        if (fromNetwork ? MANIFEST_EXT.test(abs) : isMedia(abs)) {
          window.postMessage({ __vdp: true, url: abs }, '*');
        }
      } catch {}
    }

    // Patch fetch
    const _fetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      if (url) emit(url, true);
      return _fetch.apply(this, args);
    };

    // Patch XHR
    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (url) emit(String(url), true);
      return _open.apply(this, arguments);
    };

    // Patch HTMLMediaElement.src setter
    const _srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (_srcDesc && _srcDesc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set(v) { if (v) emit(v); _srcDesc.set.call(this, v); },
        get() { return _srcDesc.get.call(this); },
        configurable: true
      });
    }

    // Patch setAttribute to catch mux-player playback-id and video src=
    const _setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      const tag = (this.tagName || '').toLowerCase();
      if (name === 'playback-id' && value && (tag === 'mux-player' || tag === 'mux-video' || tag === 'mux-audio')) {
        emit('https://stream.mux.com/' + value + '.m3u8');
      }
      if (name === 'src' && value) emit(value);
      return _setAttr.call(this, name, value);
    };

    // Patch video.load() — some players set src then call load()
    const _load = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () {
      if (this.src) emit(this.src);
      if (this.currentSrc) emit(this.currentSrc);
      this.querySelectorAll && this.querySelectorAll('source').forEach(s => { if (s.src) emit(s.src); });
      return _load.call(this);
    };

    // Patch video.play()
    const _play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.src) emit(this.src);
      if (this.currentSrc) emit(this.currentSrc);
      return _play.call(this);
    };

  })();`;

  // Inject before any other script runs
  (document.head || document.documentElement).prepend(script);
  script.remove();

  // ── 2. Listen for messages from the injected page-world script ───────────
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.__vdp || !e.data.url) return;
    const url = e.data.url;
    chrome.runtime.sendMessage({ type: 'ADD_MEDIA', url }).catch(() => {});
  });

  // ── 3. DOM scanner (runs in isolated world, but has DOM access) ───────────
  const MEDIA_EXTENSIONS = /\.(mp4|webm|mkv|avi|mov|flv|m4v|3gp|ogv|mp3|aac|ogg|flac|wav|m4a|opus|m3u8|mpd|ts)(\?|$)/i;

  function reportMedia(rawUrl) {
    if (!rawUrl) return;
    try {
      const url = new URL(rawUrl, location.href).href;
      if (url.startsWith('blob:') || url.startsWith('data:')) return;
      chrome.runtime.sendMessage({ type: 'ADD_MEDIA', url }).catch(() => {});
    } catch {}
  }

  function scanDOM() {
    // Standard video/audio
    document.querySelectorAll('video, audio').forEach(el => {
      if (el.src) reportMedia(el.src);
      if (el.currentSrc) reportMedia(el.currentSrc);
      el.querySelectorAll('source').forEach(s => {
        if (s.src) reportMedia(s.src);
        if (s.getAttribute('src')) reportMedia(s.getAttribute('src'));
      });
    });

    // Mux custom elements
    document.querySelectorAll('mux-player, mux-video, mux-audio').forEach(el => {
      const pid = el.getAttribute('playback-id') || el.getAttribute('playbackid');
      if (pid) reportMedia(`https://stream.mux.com/${pid}.m3u8`);
      if (el.src) reportMedia(el.src);
    });

    // Video.js
    document.querySelectorAll('.vjs-tech, [data-setup]').forEach(el => {
      if (el.src) reportMedia(el.src);
      if (el.currentSrc) reportMedia(el.currentSrc);
    });

    // og:video meta
    document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[name="twitter:player:stream"]').forEach(m => {
      const c = m.getAttribute('content');
      if (c) reportMedia(c);
    });

    // JSON-LD
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try { extractFromJsonLD(JSON.parse(s.textContent)); } catch {}
    });

    // Scan inline scripts for Mux playback IDs and stream URLs
    document.querySelectorAll('script:not([src])').forEach(s => {
      const text = s.textContent || '';
      // stream.mux.com URLs
      for (const m of text.matchAll(/https:\/\/stream\.mux\.com\/[a-zA-Z0-9_-]+(?:\.m3u8)?[^\s"'\\]*/g)) {
        reportMedia(m[0]);
      }
      // Mux playbackId in JSON
      for (const m of text.matchAll(/"playbackId"\s*:\s*"([a-zA-Z0-9_-]+)"/g)) {
        reportMedia(`https://stream.mux.com/${m[1]}.m3u8`);
      }
      // Any .m3u8 URL
      for (const m of text.matchAll(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/g)) {
        reportMedia(m[0]);
      }
      // Any .mp4 URL
      for (const m of text.matchAll(/https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*/g)) {
        reportMedia(m[0]);
      }
    });

    // Next.js __NEXT_DATA__
    const nextData = document.getElementById('__NEXT_DATA__');
    if (nextData) {
      try { extractFromJsonLD(JSON.parse(nextData.textContent)); } catch {}
    }
  }

  function extractFromJsonLD(data) {
    if (!data) return;
    if (typeof data === 'string') {
      if (MEDIA_EXTENSIONS.test(data) || /stream\.mux\.com/i.test(data)) reportMedia(data);
      return;
    }
    if (Array.isArray(data)) { data.forEach(extractFromJsonLD); return; }
    if (typeof data === 'object') { Object.values(data).forEach(extractFromJsonLD); }
  }

  // ── 4. MutationObserver ───────────────────────────────────────────────────
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Added nodes
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const tag = (node.tagName || '').toLowerCase();

        if (tag === 'video' || tag === 'audio') {
          if (node.src) reportMedia(node.src);
          if (node.currentSrc) reportMedia(node.currentSrc);
          node.querySelectorAll('source').forEach(s => { if (s.src) reportMedia(s.src); });
        }
        if (tag === 'mux-player' || tag === 'mux-video' || tag === 'mux-audio') {
          const pid = node.getAttribute('playback-id');
          if (pid) reportMedia(`https://stream.mux.com/${pid}.m3u8`);
        }
        if (tag === 'script' && !node.src) {
          // New inline script injected — scan it
          setTimeout(() => {
            const text = node.textContent || '';
            for (const match of text.matchAll(/https:\/\/stream\.mux\.com\/[a-zA-Z0-9_-]+(?:\.m3u8)?[^\s"'\\]*/g)) {
              reportMedia(match[0]);
            }
            for (const match of text.matchAll(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/g)) {
              reportMedia(match[0]);
            }
          }, 0);
        }
        // Scan children
        if (node.querySelectorAll) {
          node.querySelectorAll('video, audio, source, mux-player, mux-video').forEach(el => {
            if (el.src) reportMedia(el.src);
            if (el.currentSrc) reportMedia(el.currentSrc);
            const pid = el.getAttribute?.('playback-id');
            if (pid) reportMedia(`https://stream.mux.com/${pid}.m3u8`);
          });
        }
      }

      // Attribute changes
      if (m.type === 'attributes') {
        const el = m.target;
        const tag = (el.tagName || '').toLowerCase();
        if (m.attributeName === 'playback-id') {
          const pid = el.getAttribute('playback-id');
          if (pid) reportMedia(`https://stream.mux.com/${pid}.m3u8`);
        }
        if (m.attributeName === 'src') {
          const src = el.getAttribute('src');
          if (src) reportMedia(src);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'playback-id', 'data-src', 'currentSrc']
  });

  // ── 5. Initial scan + periodic re-scan ───────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanDOM);
  } else {
    scanDOM();
  }
  setTimeout(scanDOM, 1500);
  setTimeout(scanDOM, 4000);
  setTimeout(scanDOM, 8000);

})();
