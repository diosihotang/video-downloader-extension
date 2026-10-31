// tests/detector.test.js
'use strict';

const {
  isMediaUrl,
  getMediaType,
  getExtension,
  getFilename,
  extractUrlsFromScriptText,
  extractUrlsFromJsonLD,
} = require('../lib/detector');

// ─── isMediaUrl ───────────────────────────────────────────────────────────────

describe('isMediaUrl()', () => {

  describe('should DETECT as media', () => {
    const cases = [
      // Direct video files
      ['MP4 direct', 'https://cdn.example.com/video.mp4'],
      ['MP4 with query', 'https://cdn.example.com/video.mp4?token=abc123'],
      ['WebM', 'https://cdn.example.com/clip.webm'],
      ['MKV', 'https://cdn.example.com/movie.mkv'],
      ['MOV', 'https://cdn.example.com/rec.mov'],
      ['AVI', 'https://cdn.example.com/old.avi'],
      ['FLV', 'https://cdn.example.com/flash.flv'],
      // Audio
      ['MP3', 'https://cdn.example.com/track.mp3'],
      ['AAC', 'https://cdn.example.com/audio.aac'],
      ['OGG', 'https://cdn.example.com/sound.ogg'],
      ['FLAC', 'https://cdn.example.com/lossless.flac'],
      ['WAV', 'https://cdn.example.com/raw.wav'],
      ['M4A', 'https://cdn.example.com/voice.m4a'],
      // HLS / DASH
      ['M3U8 playlist', 'https://cdn.example.com/stream.m3u8'],
      ['MPD manifest', 'https://cdn.example.com/manifest.mpd'],
      ['TS segment', 'https://cdn.example.com/seg001.ts'],
      ['manifest.m3u8 path', 'https://cdn.example.com/hls/manifest.m3u8'],
      ['/hls/ path', 'https://cdn.example.com/hls/720p/index.m3u8'],
      // Known CDN domains
      ['Mux stream', 'https://stream.mux.com/abc123XYZ.m3u8'],
      ['Mux stream no ext', 'https://stream.mux.com/abc123XYZ'],
      ['Google Video', 'https://r7---sn.googlevideo.com/videoplayback?itag=137'],
      ['YouTube videoplayback', 'https://rr1---sn-xxx.googlevideo.com/videoplayback?id=abc'],
      ['Vimeo CDN', 'https://vod.vimeocdn.com/exp=123/video.mp4'],
      ['Vimeo external', 'https://vimeo.com/external/123456.hd.mp4?s=abc'],
      ['JW Player CDN', 'https://cdn.jwplayer.com/videos/abc.mp4'],
      ['CloudFront MP4', 'https://d1abc.cloudfront.net/content/video.mp4'],
      ['Fastly MP4', 'https://cdn.fastly.net/media/video.mp4'],
    ];

    test.each(cases)('%s — %s', (label, url) => {
      expect(isMediaUrl(url)).toBe(true);
    });
  });

  describe('should NOT detect as media (blocked/non-media)', () => {
    const cases = [
      ['JS file', 'https://cdn.example.com/app.js'],
      ['CSS file', 'https://cdn.example.com/style.css'],
      ['PNG image', 'https://cdn.example.com/thumb.png'],
      ['JPEG image', 'https://cdn.example.com/photo.jpg'],
      ['SVG icon', 'https://cdn.example.com/icon.svg'],
      ['Font WOFF2', 'https://cdn.example.com/font.woff2'],
      ['HTML page', 'https://cdn.example.com/page.html'],
      ['JSON file', 'https://cdn.example.com/data.json'],
      ['Google Analytics', 'https://www.google-analytics.com/collect'],
      ['GTM', 'https://www.googletagmanager.com/gtm.js?id=GTM-XXX'],
      ['DoubleClick', 'https://ad.doubleclick.net/ddm/trackimpr/'],
      ['Facebook pixel', 'https://www.facebook.com/tr?id=123&ev=PageView'],
      ['Hotjar', 'https://script.hotjar.com/modules.js'],
      ['Mixpanel', 'https://api.mixpanel.com/track'],
      ['Empty string', ''],
      ['Null', null],
      ['Undefined', undefined],
    ];

    test.each(cases)('%s — %s', (label, url) => {
      expect(isMediaUrl(url)).toBe(false);
    });
  });

});

// ─── getMediaType ─────────────────────────────────────────────────────────────

describe('getMediaType()', () => {
  const cases = [
    ['mp4', 'https://cdn.example.com/video.mp4', 'video'],
    ['webm', 'https://cdn.example.com/clip.webm', 'video'],
    ['mp3', 'https://cdn.example.com/track.mp3', 'audio'],
    ['aac', 'https://cdn.example.com/audio.aac', 'audio'],
    ['ogg', 'https://cdn.example.com/sound.ogg', 'audio'],
    ['m4a', 'https://cdn.example.com/voice.m4a', 'audio'],
    ['m3u8', 'https://cdn.example.com/stream.m3u8', 'hls/dash'],
    ['mpd', 'https://cdn.example.com/manifest.mpd', 'hls/dash'],
    ['ts segment', 'https://cdn.example.com/seg001.ts', 'hls/dash'],
    ['Mux URL', 'https://stream.mux.com/abc123.m3u8', 'hls/dash'],
    ['Mux URL no ext', 'https://stream.mux.com/abc123', 'hls/dash'],
    ['manifest.m3u8', 'https://cdn.example.com/hls/manifest.m3u8', 'hls/dash'],
    ['/hls/ path', 'https://cdn.example.com/hls/720p/video.ts', 'hls/dash'],
    ['YouTube', 'https://rr1.googlevideo.com/videoplayback?id=abc', 'video'],
    ['Vimeo CDN', 'https://vod.vimeocdn.com/video.mp4', 'video'],
  ];

  test.each(cases)('%s', (label, url, expected) => {
    expect(getMediaType(url)).toBe(expected);
  });
});

// ─── getExtension ─────────────────────────────────────────────────────────────

describe('getExtension()', () => {
  const cases = [
    ['mp4 URL', 'https://cdn.example.com/video.mp4', 'mp4'],
    ['webm URL', 'https://cdn.example.com/clip.webm', 'webm'],
    ['m3u8 URL', 'https://cdn.example.com/stream.m3u8', 'm3u8'],
    ['mpd URL', 'https://cdn.example.com/manifest.mpd', 'mpd'],
    ['mp3 URL', 'https://cdn.example.com/track.mp3', 'mp3'],
    ['m4a URL', 'https://cdn.example.com/voice.m4a', 'm4a'],
    ['YouTube videoplayback', 'https://r1.googlevideo.com/videoplayback?id=x', 'mp4'],
    ['Mux URL no ext', 'https://stream.mux.com/abc123XYZ', 'm3u8'],
    ['Mux URL with ext', 'https://stream.mux.com/abc123XYZ.m3u8', 'm3u8'],
    ['Vimeo CDN', 'https://vod.vimeocdn.com/video.mp4', 'mp4'],
    ['Unknown URL', 'https://cdn.example.com/somevideo', 'mp4'],
    ['MP4 with query string', 'https://cdn.example.com/video.mp4?v=2', 'mp4'],
  ];

  test.each(cases)('%s', (label, url, expected) => {
    expect(getExtension(url)).toBe(expected);
  });
});

// ─── getFilename ──────────────────────────────────────────────────────────────

describe('getFilename()', () => {
  test('extracts filename from URL path', () => {
    expect(getFilename('https://cdn.example.com/my-video.mp4')).toBe('my-video.mp4');
  });

  test('uses page title when provided', () => {
    const name = getFilename('https://cdn.example.com/abc123', 'My Awesome Tutorial');
    expect(name).toBe('My Awesome Tutorial.mp4');
  });

  test('sanitizes special chars from title', () => {
    const name = getFilename('https://cdn.example.com/x.mp4', 'Video: Part 1/2 <HD>');
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
    expect(name).toMatch(/\.mp4$/);
  });

  test('truncates very long titles to 100 chars + ext', () => {
    const longTitle = 'A'.repeat(200);
    const name = getFilename('https://cdn.example.com/x.mp4', longTitle);
    expect(name.length).toBeLessThanOrEqual(105); // 100 + '.mp4' + buffer
  });

  test('falls back gracefully for unknown URL', () => {
    const name = getFilename('https://cdn.example.com/stream');
    expect(name).toMatch(/\.(mp4|m3u8|webm)$/);
  });

  test('Mux URL gets .m3u8 extension', () => {
    const name = getFilename('https://stream.mux.com/abc123', 'Epic React Lesson');
    expect(name).toMatch(/\.m3u8$/);
  });
});

// ─── extractUrlsFromScriptText ────────────────────────────────────────────────

describe('extractUrlsFromScriptText()', () => {
  test('finds stream.mux.com URL in script', () => {
    const text = `var config = { src: "https://stream.mux.com/ABC123def.m3u8" };`;
    const urls = extractUrlsFromScriptText(text);
    expect(urls).toContain('https://stream.mux.com/ABC123def.m3u8');
  });

  test('finds Mux playbackId and constructs URL', () => {
    const text = `{"playbackId":"XYZ789abc","title":"Lesson 1"}`;
    const urls = extractUrlsFromScriptText(text);
    expect(urls).toContain('https://stream.mux.com/XYZ789abc.m3u8');
  });

  test('finds .m3u8 URL from any CDN', () => {
    const text = `player.src("https://cdn.example.com/hls/manifest.m3u8")`;
    const urls = extractUrlsFromScriptText(text);
    expect(urls.some(u => u.includes('.m3u8'))).toBe(true);
  });

  test('finds .mp4 URL in inline script', () => {
    const text = `var src = "https://cdn.example.com/lesson.mp4?token=abc";`;
    const urls = extractUrlsFromScriptText(text);
    expect(urls.some(u => u.includes('.mp4'))).toBe(true);
  });

  test('returns empty array for text with no media URLs', () => {
    const text = `var x = 1; console.log("hello world");`;
    expect(extractUrlsFromScriptText(text)).toEqual([]);
  });

  test('deduplicates duplicate URLs', () => {
    const text = `
      src1 = "https://stream.mux.com/ABC.m3u8";
      src2 = "https://stream.mux.com/ABC.m3u8";
    `;
    const urls = extractUrlsFromScriptText(text);
    const muxUrls = urls.filter(u => u === 'https://stream.mux.com/ABC.m3u8');
    expect(muxUrls.length).toBe(1);
  });

  test('handles empty/null input', () => {
    expect(extractUrlsFromScriptText('')).toEqual([]);
    expect(extractUrlsFromScriptText(null)).toEqual([]);
    expect(extractUrlsFromScriptText(undefined)).toEqual([]);
  });
});

// ─── extractUrlsFromJsonLD ────────────────────────────────────────────────────

describe('extractUrlsFromJsonLD()', () => {
  test('finds contentUrl in VideoObject', () => {
    const data = {
      '@type': 'VideoObject',
      name: 'Lesson 1',
      contentUrl: 'https://cdn.example.com/lesson.mp4',
    };
    const urls = extractUrlsFromJsonLD(data);
    expect(urls).toContain('https://cdn.example.com/lesson.mp4');
  });

  test('finds nested video URL', () => {
    const data = {
      '@graph': [{
        '@type': 'VideoObject',
        embedUrl: 'https://cdn.example.com/embed.mp4',
      }]
    };
    const urls = extractUrlsFromJsonLD(data);
    expect(urls.some(u => u.includes('.mp4'))).toBe(true);
  });

  test('finds Mux URL in JSON-LD', () => {
    const data = { video: { src: 'https://stream.mux.com/ABC123.m3u8' } };
    const urls = extractUrlsFromJsonLD(data);
    expect(urls).toContain('https://stream.mux.com/ABC123.m3u8');
  });

  test('ignores non-media string values', () => {
    const data = { title: 'Hello', description: 'A course about React' };
    const urls = extractUrlsFromJsonLD(data);
    expect(urls).toEqual([]);
  });

  test('handles array at root', () => {
    const data = [
      { contentUrl: 'https://cdn.example.com/a.mp4' },
      { contentUrl: 'https://cdn.example.com/b.mp4' },
    ];
    const urls = extractUrlsFromJsonLD(data);
    expect(urls).toHaveLength(2);
  });

  test('handles null/undefined gracefully', () => {
    expect(extractUrlsFromJsonLD(null)).toEqual([]);
    expect(extractUrlsFromJsonLD(undefined)).toEqual([]);
  });
});
