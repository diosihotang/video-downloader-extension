// tests/mediaStore.test.js
'use strict';

const { MediaStore } = require('../lib/mediaStore');

describe('MediaStore', () => {
  let store;

  beforeEach(() => {
    store = new MediaStore();
  });

  // ── add() ──────────────────────────────────────────────────────────────────

  describe('add()', () => {
    test('adds a new item and returns true', () => {
      const added = store.add(1, { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' });
      expect(added).toBe(true);
      expect(store.count(1)).toBe(1);
    });

    test('does not add duplicate URL for same tab, returns false', () => {
      const item = { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' };
      store.add(1, item);
      const added = store.add(1, item);
      expect(added).toBe(false);
      expect(store.count(1)).toBe(1);
    });

    test('same URL on different tabs are independent', () => {
      const item = { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' };
      store.add(1, item);
      const added = store.add(2, item);
      expect(added).toBe(true);
      expect(store.count(1)).toBe(1);
      expect(store.count(2)).toBe(1);
    });

    test('ignores invalid tabId (0, -1, null)', () => {
      expect(store.add(0, { url: 'https://cdn.example.com/video.mp4' })).toBe(false);
      expect(store.add(-1, { url: 'https://cdn.example.com/video.mp4' })).toBe(false);
      expect(store.add(null, { url: 'https://cdn.example.com/video.mp4' })).toBe(false);
    });

    test('ignores item with missing URL', () => {
      expect(store.add(1, { type: 'video' })).toBe(false);
      expect(store.add(1, null)).toBe(false);
    });

    test('stores item properties correctly', () => {
      store.add(1, { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' });
      const items = store.getAll(1);
      expect(items[0].url).toBe('https://cdn.example.com/video.mp4');
      expect(items[0].type).toBe('video');
      expect(items[0].ext).toBe('mp4');
      expect(items[0].timestamp).toBeDefined();
    });
  });

  // ── getAll() ───────────────────────────────────────────────────────────────

  describe('getAll()', () => {
    test('returns empty array for unknown tab', () => {
      expect(store.getAll(99)).toEqual([]);
    });

    test('returns all items for a tab', () => {
      store.add(1, { url: 'https://cdn.example.com/a.mp4', type: 'video', ext: 'mp4' });
      store.add(1, { url: 'https://cdn.example.com/b.mp4', type: 'video', ext: 'mp4' });
      store.add(1, { url: 'https://stream.mux.com/ABC.m3u8', type: 'hls/dash', ext: 'm3u8' });
      const items = store.getAll(1);
      expect(items).toHaveLength(3);
    });

    test('returns a copy — mutating result does not affect store', () => {
      store.add(1, { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' });
      const items = store.getAll(1);
      items.push({ url: 'injected', type: 'video', ext: 'mp4' });
      expect(store.count(1)).toBe(1);
    });
  });

  // ── count() ───────────────────────────────────────────────────────────────

  describe('count()', () => {
    test('returns 0 for empty/unknown tab', () => {
      expect(store.count(42)).toBe(0);
    });

    test('increments correctly', () => {
      store.add(1, { url: 'https://cdn.example.com/a.mp4', type: 'video', ext: 'mp4' });
      expect(store.count(1)).toBe(1);
      store.add(1, { url: 'https://cdn.example.com/b.mp4', type: 'video', ext: 'mp4' });
      expect(store.count(1)).toBe(2);
    });
  });

  // ── has() ──────────────────────────────────────────────────────────────────

  describe('has()', () => {
    test('returns true for existing URL', () => {
      store.add(1, { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' });
      expect(store.has(1, 'https://cdn.example.com/video.mp4')).toBe(true);
    });

    test('returns false for non-existing URL', () => {
      expect(store.has(1, 'https://cdn.example.com/nonexistent.mp4')).toBe(false);
    });

    test('returns false for wrong tab', () => {
      store.add(1, { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' });
      expect(store.has(2, 'https://cdn.example.com/video.mp4')).toBe(false);
    });
  });

  // ── clear() ───────────────────────────────────────────────────────────────

  describe('clear()', () => {
    test('removes all items for a tab', () => {
      store.add(1, { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' });
      store.add(1, { url: 'https://cdn.example.com/audio.mp3', type: 'audio', ext: 'mp3' });
      store.clear(1);
      expect(store.count(1)).toBe(0);
      expect(store.getAll(1)).toEqual([]);
    });

    test('clearing one tab does not affect others', () => {
      store.add(1, { url: 'https://cdn.example.com/video.mp4', type: 'video', ext: 'mp4' });
      store.add(2, { url: 'https://cdn.example.com/other.mp4', type: 'video', ext: 'mp4' });
      store.clear(1);
      expect(store.count(1)).toBe(0);
      expect(store.count(2)).toBe(1);
    });
  });

  // ── clearAll() ────────────────────────────────────────────────────────────

  describe('clearAll()', () => {
    test('wipes all tabs', () => {
      store.add(1, { url: 'https://cdn.example.com/a.mp4', type: 'video', ext: 'mp4' });
      store.add(2, { url: 'https://cdn.example.com/b.mp4', type: 'video', ext: 'mp4' });
      store.add(3, { url: 'https://cdn.example.com/c.mp4', type: 'video', ext: 'mp4' });
      store.clearAll();
      expect(store.count(1)).toBe(0);
      expect(store.count(2)).toBe(0);
      expect(store.count(3)).toBe(0);
    });
  });
});
