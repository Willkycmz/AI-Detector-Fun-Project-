/**
 * ChatStorageService.js - VisionX Milestone 3
 * IndexedDB Persistence for Conversational AI Sessions & Messages
 *
 * Mengelola penyimpanan lokal berbasis IndexedDB:
 * - Menyimpan ChatSession (id, title, createdAt, updatedAt)
 * - Menyimpan ChatMessage (id, sessionId, role, content, timestamp, snapshotThumbnail, metadata)
 * - KEAMANAN PRIVASI: Hanya thumbnail kecil (bounded size) yang boleh disimpan,
 *   citra mentah / raw full-resolution camera snapshot TIDAK PERNAH disimpan permanen.
 * - Menyediakan fitur: create, load, update, delete session, list recent chats, clear all data.
 * - Dilengkapi fallback in-memory yang aman jika IndexedDB diblokir/tidak tersedia.
 */

const DB_NAME = 'VisionX_ChatDB';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_MESSAGES = 'messages';

export class ChatStorageService {
  /**
   * @param {Object} [options={}]
   * @param {IDBFactory} [options.indexedDB]
   */
  constructor({ indexedDB = null } = {}) {
    this._idb = indexedDB || (typeof window !== 'undefined' ? window.indexedDB : null);
    this.db = null;
    this.isReady = false;
    this._memoryFallback = false;
    this._memSessions = new Map();
    this._memMessages = new Map();
    this.currentUserId = 'guest';
  }

  /**
   * Set user ID namespace for isolated chat storage
   * @param {string|null} userId
   */
  setUserId(userId) {
    this.currentUserId = userId || 'guest';
  }

  /**
   * Get current user ID namespace
   * @returns {string}
   */
  getUserId() {
    return this.currentUserId || 'guest';
  }

  /**
   * Inisialisasi basis data IndexedDB
   * @returns {Promise<boolean>}
   */
  async init() {
    if (this.isReady && (this.db || this._memoryFallback)) {
      return true;
    }

    if (!this._idb) {
      console.warn('[ChatStorageService] IndexedDB tidak tersedia, beralih ke in-memory fallback.');
      this._memoryFallback = true;
      this.isReady = true;
      return true;
    }

    return new Promise((resolve) => {
      try {
        const request = this._idb.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          // Object Store: sessions
          if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
            const sessionStore = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
            sessionStore.createIndex('updatedAt', 'updatedAt', { unique: false });
            sessionStore.createIndex('createdAt', 'createdAt', { unique: false });
          }

          // Object Store: messages
          if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
            const messageStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
            messageStore.createIndex('sessionId', 'sessionId', { unique: false });
            messageStore.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };

        request.onsuccess = (event) => {
          this.db = event.target.result;
          this.isReady = true;
          this._memoryFallback = false;
          resolve(true);
        };

        request.onerror = (err) => {
          console.warn('[ChatStorageService] Gagal membuka IndexedDB, beralih ke fallback memory:', err);
          this._memoryFallback = true;
          this.isReady = true;
          resolve(false);
        };
      } catch (err) {
        console.warn('[ChatStorageService] Exception saat inisialisasi IndexedDB:', err);
        this._memoryFallback = true;
        this.isReady = true;
        resolve(false);
      }
    });
  }

  /**
   * Helper kompresi thumbnail: pastikan tidak menyimpan raw full-resolution snapshot
   * @param {string|null} thumbnailDataUrl
   * @returns {string|null}
   */
  sanitizeThumbnail(thumbnailDataUrl) {
    if (!thumbnailDataUrl || typeof thumbnailDataUrl !== 'string') return null;
    // Jika ukuran dataURL melebihi ~80KB, potong atau abaikan agar tidak membebani IndexedDB
    if (thumbnailDataUrl.length > 120000) {
      return thumbnailDataUrl.substring(0, 120000);
    }
    return thumbnailDataUrl;
  }

  /**
   * Sanitasi pesan untuk penyimpanan IndexedDB: hapus raw full-size snapshot
   * @param {Object} msg
   * @returns {Object}
   */
  _sanitizeMessage(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    const { snapshot, ...rest } = msg;
    return {
      ...rest,
      snapshotThumbnail: this.sanitizeThumbnail(msg.snapshotThumbnail || null)
    };
  }

  /**
   * Mengambil semua sesi obrolan terurut dari yang terbaru
   * @returns {Promise<Array<Object>>}
   */
  async getSessions() {
    await this.init();
    const activeUserId = this.currentUserId || 'guest';

    if (this._memoryFallback) {
      const list = Array.from(this._memSessions.values())
        .filter(s => (s.userId || 'guest') === activeUserId);
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return list;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction([STORE_SESSIONS], 'readonly');
        const store = tx.objectStore(STORE_SESSIONS);
        const index = store.index('updatedAt');
        const req = index.openCursor(null, 'prev'); // Urut descending

        const sessions = [];
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const val = cursor.value;
            if ((val.userId || 'guest') === activeUserId) {
              sessions.push(val);
            }
            cursor.continue();
          } else {
            resolve(sessions);
          }
        };

        req.onerror = () => {
          resolve([]);
        };
      } catch (err) {
        console.warn('[ChatStorageService] Error getSessions:', err);
        resolve([]);
      }
    });
  }

  /**
   * Mengambil sesi berdasarkan ID
   * @param {string} sessionId
   * @returns {Promise<Object|null>}
   */
  async getSession(sessionId) {
    await this.init();
    if (!sessionId) return null;

    if (this._memoryFallback) {
      return this._memSessions.get(sessionId) || null;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction([STORE_SESSIONS], 'readonly');
        const store = tx.objectStore(STORE_SESSIONS);
        const req = store.get(sessionId);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  /**
   * Membuat atau memperbarui sesi obrolan
   * @param {string} sessionId
   * @param {string} title
   * @param {number} [createdAt=Date.now()]
   * @returns {Promise<Object>}
   */
  async createSession(sessionId, title = 'Percakapan Baru', createdAt = Date.now()) {
    await this.init();
    const session = {
      id: sessionId,
      userId: this.currentUserId || 'guest',
      title: String(title || 'Percakapan Baru').trim().substring(0, 80),
      createdAt: Number(createdAt) || Date.now(),
      updatedAt: Date.now()
    };

    if (this._memoryFallback) {
      this._memSessions.set(sessionId, session);
      return session;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([STORE_SESSIONS], 'readwrite');
        const store = tx.objectStore(STORE_SESSIONS);
        const req = store.put(session);

        req.onsuccess = () => resolve(session);
        req.onerror = (e) => reject(e.target.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Memperbarui metadata sesi (judul atau waktu terakhir update)
   * @param {string} sessionId
   * @param {Object} updates { title?: string, updatedAt?: number }
   * @returns {Promise<Object|null>}
   */
  async updateSession(sessionId, updates = {}) {
    await this.init();
    const existing = await this.getSession(sessionId);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      updatedAt: Date.now()
    };

    if (this._memoryFallback) {
      this._memSessions.set(sessionId, updated);
      return updated;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([STORE_SESSIONS], 'readwrite');
        const store = tx.objectStore(STORE_SESSIONS);
        const req = store.put(updated);

        req.onsuccess = () => resolve(updated);
        req.onerror = (e) => reject(e.target.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Menghapus sesi beserta seluruh pesannya
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async deleteSession(sessionId) {
    await this.init();
    if (!sessionId) return false;

    if (this._memoryFallback) {
      this._memSessions.delete(sessionId);
      // Hapus pesan terkait
      for (const [msgId, msg] of this._memMessages.entries()) {
        if (msg.sessionId === sessionId) {
          this._memMessages.delete(msgId);
        }
      }
      return true;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction([STORE_SESSIONS, STORE_MESSAGES], 'readwrite');
        const sessionStore = tx.objectStore(STORE_SESSIONS);
        const messageStore = tx.objectStore(STORE_MESSAGES);

        sessionStore.delete(sessionId);

        // Hapus semua pesan dengan sessionId ini
        const index = messageStore.index('sessionId');
        const req = index.openCursor(IDBKeyRange.only(sessionId));

        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        console.warn('[ChatStorageService] Error deleteSession:', err);
        resolve(false);
      }
    });
  }

  /**
   * Menyimpan pesan chat ke IndexedDB
   * @param {Object} message
   * @returns {Promise<Object>}
   */
  async saveMessage({
    id,
    sessionId,
    role,
    content,
    timestamp = Date.now(),
    snapshotThumbnail = null,
    metadata = {}
  }) {
    await this.init();

    const record = {
      id: id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      sessionId: sessionId || 'default_session',
      userId: this.currentUserId || 'guest',
      role: role === 'assistant' ? 'assistant' : 'user',
      content: String(content || '').trim(),
      timestamp: Number(timestamp) || Date.now(),
      snapshotThumbnail: this.sanitizeThumbnail(snapshotThumbnail),
      metadata: metadata || {}
    };

    if (this._memoryFallback) {
      this._memMessages.set(record.id, record);
      // Update session updatedAt
      const sess = this._memSessions.get(record.sessionId);
      if (sess) {
        sess.updatedAt = record.timestamp;
      }
      return record;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([STORE_MESSAGES, STORE_SESSIONS], 'readwrite');
        const msgStore = tx.objectStore(STORE_MESSAGES);
        const sessStore = tx.objectStore(STORE_SESSIONS);

        msgStore.put(record);

        // Perbarui timestamp sesi
        const sessReq = sessStore.get(record.sessionId);
        sessReq.onsuccess = () => {
          if (sessReq.result) {
            sessReq.result.updatedAt = record.timestamp;
            sessStore.put(sessReq.result);
          }
        };

        tx.oncomplete = () => resolve(record);
        tx.onerror = (e) => reject(e.target.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Mengambil semua pesan untuk sesi tertentu terurut kronologis
   * @param {string} sessionId
   * @returns {Promise<Array<Object>>}
   */
  async getMessages(sessionId) {
    await this.init();
    if (!sessionId) return [];

    if (this._memoryFallback) {
      const msgs = [];
      for (const msg of this._memMessages.values()) {
        if (msg.sessionId === sessionId) {
          msgs.push(msg);
        }
      }
      msgs.sort((a, b) => a.timestamp - b.timestamp);
      return msgs;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction([STORE_MESSAGES], 'readonly');
        const store = tx.objectStore(STORE_MESSAGES);
        const index = store.index('sessionId');
        const req = index.openCursor(IDBKeyRange.only(sessionId));

        const messages = [];
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            messages.push(cursor.value);
            cursor.continue();
          } else {
            messages.sort((a, b) => a.timestamp - b.timestamp);
            resolve(messages);
          }
        };

        req.onerror = () => resolve([]);
      } catch (err) {
        console.warn('[ChatStorageService] Error getMessages:', err);
        resolve([]);
      }
    });
  }

  /**
   * Menghapus seluruh data obrolan (sessions dan messages) dengan aman
   * @returns {Promise<boolean>}
   */
  async clearAllData() {
    await this.init();
    const activeUserId = this.currentUserId || 'guest';

    if (this._memoryFallback) {
      for (const [id, s] of this._memSessions.entries()) {
        if ((s.userId || 'guest') === activeUserId) {
          this._memSessions.delete(id);
          for (const [mId, m] of this._memMessages.entries()) {
            if (m.sessionId === id) this._memMessages.delete(mId);
          }
        }
      }
      return true;
    }

    try {
      const userSessions = await this.getSessions();
      for (const sess of userSessions) {
        await this.deleteSession(sess.id);
      }
      return true;
    } catch (err) {
      console.warn('[ChatStorageService] Error clearAllData:', err);
      return false;
    }
  }
}
