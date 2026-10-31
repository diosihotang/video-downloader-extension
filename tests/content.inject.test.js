/**
 * @jest-environment jest-environment-jsdom
 */
// tests/content.inject.test.js
// Tests the page-world injector logic using jest-environment-jsdom.
// jsdom provides window/document/XMLHttpRequest/HTMLMediaElement globally.
'use strict';

// The injector code — same IIFE that content.js injects into the page.
// We run it once per test suite to patch the jsdom window.
const INJECTOR_CODE = `(function () {
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

  function emit(url) {
    try {
      const abs = new URL(url, location.href).href;
      if (isMedia(abs)) {
        window.__vdp_captured = window.__vdp_captured || [];
        window.__vdp_captured.push(abs);
      }
    } catch {}
  }

  // Patch fetch
  const _fetch = window.fetch || function() { return Promise.resolve({ ok: true }); };
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    if (url) emit(url);
    return _fetch.apply(this, args);
  };

  // Patch XHR
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (url) emit(String(url));
    return _open.apply(this, arguments);
  };

  // Patch setAttribute
  const _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const tag = (this.tagName || '').toLowerCase();
    if (name === 'playback-id' && value &&
        (tag === 'mux-player' || tag === 'mux-video' || tag === 'mux-audio')) {
      emit('https://stream.mux.com/' + value + '.m3u8');
    }
    if (name === 'src' && value) emit(value);
    return _setAttr.call(this, name, value);
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

  window.__vdp_emit = emit;
})();`;

// Helper: reset captured list and re-run injector before each test
function setupInjector() {
  window.__vdp_captured = [];
  // eslint-disable-next-line no-eval
  eval(INJECTOR_CODE);
}

function captured() {
  return window.__vdp_captured || [];
}

// ─── fetch() interception ────────────────────────────────────────────────────

describe('Page-world injector: fetch() interception', () => {
  beforeEach(setupInjector);

  test('detects MP4 fetched via fetch()', () => {
    window.fetch('https://cdn.example.com/video.mp4');
    expect(captured()).toContain('https://cdn.example.com/video.mp4');
  });

  test('detects M3U8 fetched via fetch()', () => {
    window.fetch('https://cdn.example.com/stream.m3u8');
    expect(captured()).toContain('https://cdn.example.com/stream.m3u8');
  });

  test('detects Mux stream.mux.com via fetch()', () => {
    window.fetch('https://stream.mux.com/ABC123xyz.m3u8');
    expect(captured()).toContain('https://stream.mux.com/ABC123xyz.m3u8');
  });

  test('detects Mux URL without .m3u8 extension', () => {
    window.fetch('https://stream.mux.com/ABC123xyz');
    expect(captured()).toContain('https://stream.mux.com/ABC123xyz');
  });

  test('detects googlevideo.com (YouTube) URL', () => {
    window.fetch('https://r1---sn.googlevideo.com/videoplayback?id=abc&itag=137');
    expect(captured().some(u => u.includes('googlevideo.com'))).toBe(true);
  });

  test('detects vimeocdn.com URL', () => {
    window.fetch('https://vod.vimeocdn.com/exp=123/video.mp4');
    expect(captured().some(u => u.includes('vimeocdn.com'))).toBe(true);
  });

  test('does NOT capture .js files', () => {
    window.fetch('https://cdn.example.com/chunk.abc123.js');
    expect(captured()).toHaveLength(0);
  });

  test('does NOT capture .css files', () => {
    window.fetch('https://cdn.example.com/style.css');
    expect(captured()).toHaveLength(0);
  });

  test('does NOT capture .png images', () => {
    window.fetch('https://cdn.example.com/thumbnail.png');
    expect(captured()).toHaveLength(0);
  });

  test('does NOT capture google-analytics URLs', () => {
    window.fetch('https://www.google-analytics.com/collect?v=1');
    expect(captured()).toHaveLength(0);
  });
});

// ─── XHR interception ────────────────────────────────────────────────────────

describe('Page-world injector: XMLHttpRequest interception', () => {
  beforeEach(setupInjector);

  test('detects M3U8 opened via XHR', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://cdn.example.com/hls/manifest.m3u8');
    expect(captured()).toContain('https://cdn.example.com/hls/manifest.m3u8');
  });

  test('detects MP4 opened via XHR', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://cdn.example.com/video.mp4');
    expect(captured().some(u => u.includes('.mp4'))).toBe(true);
  });

  test('detects Mux stream opened via XHR', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://stream.mux.com/ABC123.m3u8');
    expect(captured()).toContain('https://stream.mux.com/ABC123.m3u8');
  });

  test('does NOT capture analytics XHR', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://www.google-analytics.com/collect');
    expect(captured()).toHaveLength(0);
  });

  test('does NOT capture JS XHR', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://cdn.example.com/vendor.js');
    expect(captured()).toHaveLength(0);
  });
});

// ─── setAttribute interception ───────────────────────────────────────────────

describe('Page-world injector: setAttribute interception', () => {
  beforeEach(setupInjector);

  test('detects mux-player playback-id attribute', () => {
    const el = document.createElement('mux-player');
    document.body.appendChild(el);
    el.setAttribute('playback-id', 'TestPlaybackID123');
    expect(captured()).toContain('https://stream.mux.com/TestPlaybackID123.m3u8');
  });

  test('detects mux-video playback-id attribute', () => {
    const el = document.createElement('mux-video');
    document.body.appendChild(el);
    el.setAttribute('playback-id', 'AnotherID456');
    expect(captured()).toContain('https://stream.mux.com/AnotherID456.m3u8');
  });

  test('detects video src attribute set dynamically', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    video.setAttribute('src', 'https://cdn.example.com/lesson.mp4');
    expect(captured().some(u => u.includes('lesson.mp4'))).toBe(true);
  });

  test('does NOT emit non-media src attribute', () => {
    const img = document.createElement('img');
    document.body.appendChild(img);
    img.setAttribute('src', 'https://cdn.example.com/thumb.png');
    expect(captured()).toHaveLength(0);
  });
});

// ─── HTMLMediaElement.src setter ─────────────────────────────────────────────

describe('Page-world injector: HTMLMediaElement.src setter', () => {
  beforeEach(setupInjector);

  test('detects src set directly on video element', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    video.src = 'https://cdn.example.com/course.mp4';
    expect(captured().some(u => u.includes('course.mp4'))).toBe(true);
  });

  test('detects M3U8 set on video.src', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    video.src = 'https://cdn.example.com/stream.m3u8';
    expect(captured().some(u => u.includes('.m3u8'))).toBe(true);
  });
});

// ─── Blob / data URL guard ───────────────────────────────────────────────────

describe('Page-world injector: blob/data URL exclusion', () => {
  beforeEach(setupInjector);

  test('does not capture blob: URLs', () => {
    window.fetch('blob:https://app.epicreact.dev/some-id');
    expect(captured()).toHaveLength(0);
  });

  test('does not capture data: URLs', () => {
    window.fetch('data:video/mp4;base64,AAAA');
    expect(captured()).toHaveLength(0);
  });
});
