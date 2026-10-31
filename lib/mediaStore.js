// lib/mediaStore.js
// In-memory store for detected media per tab. Zero Chrome API dependencies.

'use strict';

class MediaStore {
  constructor() {
    /** @type {Map<number, Map<string, object>>} */
    this._store = new Map();
  }

  /**
   * Add a media item for a tab. No-op if URL already exists for that tab.
   * @param {number} tabId
   * @param {object} item  { url, type, ext, ... }
   * @returns {boolean} true if item was newly added
   */
  add(tabId, item) {
    if (!tabId || tabId < 0 || !item?.url) return false;
    if (!this._store.has(tabId)) this._store.set(tabId, new Map());
    const tab = this._store.get(tabId);
    if (tab.has(item.url)) return false;
    tab.set(item.url, { ...item, timestamp: Date.now() });
    return true;
  }

  /**
   * Get all media items for a tab.
   * @param {number} tabId
   * @returns {object[]}
   */
  getAll(tabId) {
    return this._store.has(tabId)
      ? Array.from(this._store.get(tabId).values())
      : [];
  }

  /**
   * Return count of items for a tab.
   * @param {number} tabId
   * @returns {number}
   */
  count(tabId) {
    return this._store.get(tabId)?.size ?? 0;
  }

  /**
   * Clear all media for a tab.
   * @param {number} tabId
   */
  clear(tabId) {
    this._store.delete(tabId);
  }

  /**
   * Clear everything (e.g. for test teardown).
   */
  clearAll() {
    this._store.clear();
  }

  /**
   * Check if a URL already exists for a tab.
   * @param {number} tabId
   * @param {string} url
   * @returns {boolean}
   */
  has(tabId, url) {
    return this._store.get(tabId)?.has(url) ?? false;
  }
}

module.exports = { MediaStore };
