// tests/hls.test.js
'use strict';

const nodeCrypto = require('crypto');
const H = require('../lib/hls');
const { classifyMedia } = require('../lib/detector');

// ─── MP4 box helpers (just enough structure for the rewriting code) ───────────

function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map(p => Buffer.from(p)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}
const u32 = (...vals) => { const b = Buffer.alloc(4 * vals.length); vals.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b; };
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };

function initSegment() {
  return Buffer.concat([
    box('ftyp', 'isom', u32(0)),
    box('moov',
      box('mvhd', u32(0, 0, 0, 1000, 0xFFFFFFFF)),                  // v0: flags, ctime, mtime, timescale, duration
      box('trak',
        box('tkhd', u32(0, 0, 0, 1, 0, 0xFFFFFFFF)),                // v0: flags, ctime, mtime, trackId, reserved, duration
        box('mdia', box('mdhd', u32(0, 0, 0, 90000, 0xFFFFFFFF))))),
  ]);
}

function mediaSegment(trackId, baseDecodeTime) {
  return Buffer.concat([
    box('sidx', u32(0, 1, 90000)),
    box('moof', box('traf',
      box('tfhd', u32(0, trackId)),
      box('tfdt', Buffer.from([1, 0, 0, 0]), u64(baseDecodeTime)))),
    box('mdat', 'payload'),
  ]);
}

function readTfdt(bytes) {
  const buf = Buffer.from(bytes);
  const i = buf.indexOf('tfdt');
  return Number(buf.readBigUInt64BE(i + 8));
}

function fakeNetwork(files) {
  const requested = [];
  return {
    requested,
    fetchText: async (url) => {
      requested.push(url);
      if (!(url in files)) throw new Error('404 ' + url);
      return files[url];
    },
    fetchBytes: async (url, range) => {
      requested.push(url);
      if (!(url in files)) throw new Error('404 ' + url);
      const data = Buffer.from(files[url]);
      return new Uint8Array(range ? data.subarray(range.offset, range.offset + range.length) : data);
    },
  };
}

// ─── parsePlaylist ────────────────────────────────────────────────────────────

describe('parsePlaylist()', () => {
  test('parses a master playlist with relative variant URLs', () => {
    const pl = H.parsePlaylist([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
      'https://cdn.example.com/high/index.m3u8?token=abc',
    ].join('\n'), 'https://stream.example.com/video/master.m3u8?sig=1');

    expect(pl.type).toBe('master');
    expect(pl.variants).toEqual([
      expect.objectContaining({ url: 'https://stream.example.com/video/low/index.m3u8', height: 360, bandwidth: 800000 }),
      expect.objectContaining({ url: 'https://cdn.example.com/high/index.m3u8?token=abc', height: 1080 }),
    ]);
  });

  test('parses a media playlist: durations, sequence, key, map, byte ranges', () => {
    const pl = H.parsePlaylist([
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:7',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:500@100',
      'main.mp4',
      '#EXTINF:2.5,',
      '#EXT-X-BYTERANGE:300',
      'main.mp4',
      '#EXT-X-ENDLIST',
    ].join('\r\n'), 'https://x.com/v/media.m3u8');

    expect(pl.type).toBe('media');
    expect(pl.endList).toBe(true);
    expect(pl.duration).toBeCloseTo(6.5);
    expect(pl.segments).toHaveLength(2);
    expect(pl.segments[0]).toMatchObject({
      url: 'https://x.com/v/main.mp4', seq: 7, duration: 4,
      byteRange: { offset: 100, length: 500 },
      key: { method: 'AES-128', url: 'https://x.com/v/key.bin', iv: null },
      map: { url: 'https://x.com/v/init.mp4', byteRange: { offset: 0, length: 100 } },
    });
    // Byte range without @offset continues where the previous one ended
    expect(pl.segments[1]).toMatchObject({ seq: 8, byteRange: { offset: 600, length: 300 } });
  });

  test('rejects non-playlists and DRM', () => {
    expect(() => H.parsePlaylist('<html>', 'https://x.com/a.m3u8')).toThrow('Not an HLS playlist');
    expect(() => H.parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:4,\na.ts', 'https://x.com/a.m3u8'))
      .toThrow(/not supported/);
  });
});

describe('pickBestVariant()', () => {
  test('prefers resolution, then bitrate', () => {
    const best = H.pickBestVariant([
      { url: 'a', height: 720, bandwidth: 9e6 },
      { url: 'b', height: 1080, bandwidth: 4e6 },
      { url: 'c', height: 1080, bandwidth: 6e6 },
    ]);
    expect(best.url).toBe('c');
  });

  describe('with setMaxHeight()', () => {
    const variants = [
      { url: 'uhd', height: 2160, bandwidth: 9e6 },
      { url: 'hd', height: 1080, bandwidth: 4e6 },
      { url: 'sd', height: 540, bandwidth: 1e6 },
    ];
    afterEach(() => H.setMaxHeight(0));

    test('skips variants above the cap', () => {
      H.setMaxHeight(1080);
      expect(H.pickBestVariant(variants).url).toBe('hd');
    });

    test('falls back to the smallest variant when all exceed the cap', () => {
      H.setMaxHeight(360);
      expect(H.pickBestVariant(variants).url).toBe('sd');
    });

    test('0 removes the cap', () => {
      H.setMaxHeight(1080);
      H.setMaxHeight(0);
      expect(H.pickBestVariant(variants).url).toBe('uhd');
    });
  });
});

describe('probe()', () => {
  test('reports best quality, duration and child playlists of a master', async () => {
    const net = fakeNetwork({
      'https://s.com/m.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nhd.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nsd.m3u8',
      'https://s.com/hd.m3u8': '#EXTM3U\n#EXTINF:10,\na.ts\n#EXTINF:5.4,\nb.ts\n#EXT-X-ENDLIST',
    });
    const info = await H.probe('https://s.com/m.m3u8', net.fetchText);
    expect(info).toEqual({
      kind: 'master', height: 720, duration: 15,
      childUrls: ['https://s.com/hd.m3u8', 'https://s.com/sd.m3u8'],
    });
  });
});

// ─── downloadHls ──────────────────────────────────────────────────────────────

describe('downloadHls() — fragmented MP4 streams', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,', 'seg1.mp4',
    '#EXTINF:4,', 'seg2.mp4',
    '#EXTINF:2,', 'seg3.mp4',
    '#EXT-X-ENDLIST',
  ].join('\n');

  function files() {
    return {
      'https://s.com/v.m3u8': playlist,
      'https://s.com/init.mp4': initSegment(),
      'https://s.com/seg1.mp4': mediaSegment(1, 900000),
      'https://s.com/seg2.mp4': mediaSegment(1, 1260000),
      'https://s.com/seg3.mp4': mediaSegment(1, 1620000),
    };
  }

  test('downloads every segment (not just one) in order, after the init segment', async () => {
    const net = fakeNetwork(files());
    const progress = [];
    const result = await H.downloadHls('https://s.com/v.m3u8', { ...net, onProgress: p => progress.push(p) });

    expect(result.parts).toHaveLength(4);
    expect(Buffer.from(result.parts[0]).includes('moov')).toBe(true);
    expect(result.duration).toBe(10);
    expect(progress.at(-1)).toEqual({ phase: 'downloading', done: 3, total: 3 });
  });

  test('rebases timestamps to start at zero and neutralises sidx', async () => {
    const result = await H.downloadHls('https://s.com/v.m3u8', fakeNetwork(files()));
    expect(result.parts.slice(1).map(readTfdt)).toEqual([0, 360000, 720000]);
    expect(result.parts.slice(1).some(p => Buffer.from(p).includes('sidx'))).toBe(false);
  });

  test('writes the real duration into the init segment headers', async () => {
    const result = await H.downloadHls('https://s.com/v.m3u8', fakeNetwork(files()));
    const init = Buffer.from(result.parts[0]);
    const mvhd = init.indexOf('mvhd');
    const tkhd = init.indexOf('tkhd');
    const mdhd = init.indexOf('mdhd');
    expect(init.readUInt32BE(mvhd + 4 + 16)).toBe(10 * 1000);   // movie timescale 1000
    expect(init.readUInt32BE(tkhd + 4 + 20)).toBe(10 * 1000);
    expect(init.readUInt32BE(mdhd + 4 + 16)).toBe(10 * 90000);  // media timescale 90000
  });

  test('picks the best variant from a master playlist', async () => {
    const f = files();
    f['https://s.com/master.m3u8'] = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080\nv.m3u8';
    const net = fakeNetwork(f);
    const result = await H.downloadHls('https://s.com/master.m3u8', net);
    expect(result.height).toBe(1080);
    expect(net.requested).not.toContain('https://s.com/low.m3u8');
  });

  test('decrypts AES-128 segments', async () => {
    const key = nodeCrypto.randomBytes(16);
    const plain = mediaSegment(1, 0);
    const iv = Buffer.alloc(16); iv.writeUInt32BE(0, 12); // IV defaults to the media sequence number
    const cipher = nodeCrypto.createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);

    const net = fakeNetwork({
      'https://s.com/e.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\ns.mp4\n#EXT-X-ENDLIST',
      'https://s.com/init.mp4': initSegment(),
      'https://s.com/k': key,
      'https://s.com/s.mp4': encrypted,
    });
    const result = await H.downloadHls('https://s.com/e.m3u8', net);
    expect(Buffer.from(result.parts[1]).includes('payload')).toBe(true);
  });

  test('retries a flaky segment', async () => {
    const net = fakeNetwork(files());
    let failures = 1;
    const fetchBytes = async (url, range) => {
      if (url.endsWith('seg2.mp4') && failures-- > 0) throw new Error('network blip');
      return net.fetchBytes(url, range);
    };
    const result = await H.downloadHls('https://s.com/v.m3u8', { ...net, fetchBytes });
    expect(result.parts).toHaveLength(4);
  });

  test('explains unsupported streams instead of producing a broken file', async () => {
    const live = fakeNetwork({ 'https://s.com/live.m3u8': '#EXTM3U\n#EXTINF:4,\na.ts' });
    await expect(H.downloadHls('https://s.com/live.m3u8', live)).rejects.toThrow('Live streams');

    const separateAudio = fakeNetwork({
      'https://s.com/m.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="aud"\nv.m3u8',
      'https://s.com/v.m3u8': playlist,
    });
    await expect(H.downloadHls('https://s.com/m.m3u8', separateAudio)).rejects.toThrow('separate audio');
  });
});

// ─── classifyMedia ────────────────────────────────────────────────────────────

describe('classifyMedia()', () => {
  test('HLS / DASH manifests are offered', () => {
    expect(classifyMedia('https://stream.mux.com/abc.m3u8?token=x', { requestType: 'xmlhttprequest' })).toEqual({ kind: 'hls', ext: 'm3u8' });
    expect(classifyMedia('https://x.com/playlist', { requestType: 'xmlhttprequest', contentType: 'application/vnd.apple.mpegurl' })).toEqual({ kind: 'hls', ext: 'm3u8' });
    expect(classifyMedia('https://x.com/manifest.mpd')).toEqual({ kind: 'dash', ext: 'mpd' });
  });

  test('.mp4 fetched by a streaming player (XHR/fetch) is a segment, not a video', () => {
    expect(classifyMedia('https://cdn.x.com/v/segment_5.mp4', { requestType: 'xmlhttprequest' })).toBeNull();
    expect(classifyMedia('https://cdn.x.com/v/chunk.mp4?range=0-99999', { requestType: 'fetch' })).toBeNull();
  });

  test('segment extensions are never offered', () => {
    expect(classifyMedia('https://cdn.x.com/seg001.ts', { requestType: 'media' })).toBeNull();
    expect(classifyMedia('https://cdn.x.com/seg001.m4s', { requestType: 'element' })).toBeNull();
  });

  test('real files loaded by <video>, links or markup are offered', () => {
    expect(classifyMedia('https://cdn.x.com/movie.mp4', { requestType: 'media' })).toEqual({ kind: 'file', ext: 'mp4' });
    expect(classifyMedia('https://cdn.x.com/movie.webm', { requestType: 'element' })).toEqual({ kind: 'file', ext: 'webm' });
    expect(classifyMedia('https://cdn.x.com/play', { requestType: 'media', contentType: 'video/mp4' })).toEqual({ kind: 'file', ext: 'mp4' });
  });

  test('non-http and non-media URLs are ignored', () => {
    expect(classifyMedia('blob:https://x.com/123')).toBeNull();
    expect(classifyMedia('https://x.com/app.js', { requestType: 'script' })).toBeNull();
    expect(classifyMedia('https://x.com/page', { requestType: 'main_frame' })).toBeNull();
  });
});
