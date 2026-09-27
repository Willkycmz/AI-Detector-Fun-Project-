/**
 * MemoryQueryEngine.js - VisionX V1.1 Deterministic Ground-Truth Memory Query Engine
 *
 * Menganalisis intent pertanyaan pengguna terkait memori temporal dan spasial objek,
 * lalu menghasilkan jawaban akurat berbasis data nyata dari ObjectMemory (ZERO HALLUCINATION).
 *
 * Mendukung intent:
 * - LAST_SEEN: "kapan laptop terakhir terlihat?", "laptop terakhir ada di mana?", "di mana botol tadi?"
 * - CURRENTLY_VISIBLE: "objek apa yang sedang terlihat?", "apakah ada mouse sekarang?"
 * - COUNT: "berapa laptop yang terlihat?", "berapa kali mouse terdeteksi?"
 * - ENTERED: "objek apa yang baru masuk / muncul?"
 * - LEFT: "objek apa yang baru hilang / keluar?"
 * - RETURNED: "objek apa yang baru kembali?"
 * - HISTORY: "riwayat laptop #01", "ceritakan riwayat mouse"
 */

import { TrackMemoryState } from './ObjectMemory.js';

export const QueryIntent = {
  LAST_SEEN: 'LAST_SEEN',
  CURRENTLY_VISIBLE: 'CURRENTLY_VISIBLE',
  COUNT: 'COUNT',
  ENTERED: 'ENTERED',
  LEFT: 'LEFT',
  RETURNED: 'RETURNED',
  HISTORY: 'HISTORY',
  UNKNOWN: 'UNKNOWN'
};

// Daftar kata benda / kelas umum yang didukung oleh model VisionX
const RECOGNIZED_CLASSES = [
  'earphone', 'bottle', 'charger', 'mouse', 'pen', 'phone', 'smartwatch',
  'laptop', 'person', 'cup', 'keyboard', 'book', 'cell phone', 'tv', 'chair'
];

export class MemoryQueryEngine {
  /**
   * Cek apakah pertanyaan pengguna adalah pertanyaan memori
   * @param {string} question
   * @returns {boolean}
   */
  static isMemoryQuestion(question) {
    const q = String(question || '').toLowerCase().trim();
    if (!q) return false;

    const memoryKeywords = [
      'terakhir', 'tadi', 'riwayat', 'pernah', 'kemarin', 'sebelumnya',
      'baru masuk', 'baru hilang', 'baru muncul', 'baru keluar', 'kembali',
      'kapan', 'di mana tadi', 'dimana tadi', 'dimana terakhir', 'di mana terakhir',
      'posisi tadi', 'berapa kali', 'berapa objek yang terlihat', 'apa yang baru',
      'sedang terlihat', 'lagi terlihat', 'saat ini', 'sekarang',
      // V1.2 Personalized Keywords
      'gw', 'gue', 'saya', 'aku', 'milik saya', 'milik gw', 'punya gw', 'punyaku',
      'my ', 'barang gw', 'barang saya', 'benda gw', 'benda saya'
    ];

    return memoryKeywords.some(kw => q.includes(kw));
  }

  /**
   * Ekstraksi target kelas, trackId, atau nama objek personal dari teks pertanyaan
   * @param {string} qLower
   * @param {Object|null} [personalObjectRegistry=null]
   * @returns {{ targetClass: string|null, targetTrackId: number|null, isPersonalQuery: boolean, personalObjectName: string|null }}
   */
  static extractTarget(qLower, personalObjectRegistry = null) {
    // Deteksi apakah pertanyaan mengandung kata ganti milik personal
    const isPersonalQuery = (
      qLower.includes('gw') || qLower.includes('gue') || qLower.includes('saya') ||
      qLower.includes('aku') || qLower.includes('milik') || qLower.includes('punya') ||
      qLower.includes('my ') || qLower.includes('barang gw') || qLower.includes('barang saya')
    );

    // Cek apakah ada objek yang cocok dengan nama di registry
    let personalObjectName = null;
    if (personalObjectRegistry && typeof personalObjectRegistry.getAll === 'function') {
      for (const obj of personalObjectRegistry.getAll()) {
        const objNameLower = obj.name.toLowerCase();
        if (qLower.includes(objNameLower)) {
          personalObjectName = obj.name;
          break;
        }
      }
    }

    // Cari trackId spesifik seperti '#01', '#1', 'track 1', 'id 2'
    const trackMatch = qLower.match(/#?(\d+)/);
    let targetTrackId = null;
    if (trackMatch && (qLower.includes('#') || qLower.includes('track') || qLower.includes('id'))) {
      targetTrackId = parseInt(trackMatch[1], 10);
    }

    // Cari nama kelas yang cocok
    let targetClass = null;
    let targetWord = null;
    for (const cls of RECOGNIZED_CLASSES) {
      if (qLower.includes(cls)) {
        targetClass = cls;
        targetWord = cls;
        break;
      }
    }

    // Sinonim bahasa Indonesia
    if (!targetClass) {
      if (qLower.includes('botol')) { targetClass = 'bottle'; targetWord = 'botol'; }
      else if (qLower.includes('ponsel')) { targetClass = 'phone'; targetWord = 'ponsel'; }
      else if (qLower.includes('hp')) { targetClass = 'phone'; targetWord = 'hp'; }
      else if (qLower.includes('jam tangan')) { targetClass = 'smartwatch'; targetWord = 'jam tangan'; }
      else if (qLower.includes('jam')) { targetClass = 'smartwatch'; targetWord = 'jam'; }
      else if (qLower.includes('pulpen')) { targetClass = 'pen'; targetWord = 'pulpen'; }
      else if (qLower.includes('pena')) { targetClass = 'pen'; targetWord = 'pena'; }
      else if (qLower.includes('orang')) { targetClass = 'person'; targetWord = 'orang'; }
      else if (qLower.includes('manusia')) { targetClass = 'person'; targetWord = 'manusia'; }
      else if (qLower.includes('cangkir')) { targetClass = 'cup'; targetWord = 'cangkir'; }
      else if (qLower.includes('gelas')) { targetClass = 'cup'; targetWord = 'gelas'; }
      else if (qLower.includes('buku')) { targetClass = 'book'; targetWord = 'buku'; }
    }

    return { targetClass, targetWord, targetTrackId, isPersonalQuery, personalObjectName };
  }

  /**
   * Deteksi intent pertanyaan memori
   * @param {string} qLower
   * @returns {string} QueryIntent
   */
  static detectIntent(qLower) {
    if (qLower.includes('baru masuk') || qLower.includes('baru muncul') || qLower.includes('masuk')) {
      return QueryIntent.ENTERED;
    }
    if (qLower.includes('baru hilang') || qLower.includes('baru keluar') || qLower.includes('hilang')) {
      return QueryIntent.LEFT;
    }
    if (qLower.includes('kembali') || qLower.includes('balik')) {
      return QueryIntent.RETURNED;
    }
    if (qLower.includes('berapa') || qLower.includes('jumlah') || qLower.includes('total')) {
      return QueryIntent.COUNT;
    }
    if (qLower.includes('riwayat') || qLower.includes('histori') || qLower.includes('ceritakan')) {
      return QueryIntent.HISTORY;
    }
    if (qLower.includes('terakhir') || qLower.includes('kapan') || qLower.includes('di mana') || qLower.includes('dimana') || qLower.includes('tadi') || qLower.includes('ada di')) {
      return QueryIntent.LAST_SEEN;
    }
    if (qLower.includes('sedang terlihat') || qLower.includes('lagi terlihat') || qLower.includes('terlihat') || qLower.includes('sekarang') || qLower.includes('saat ini') || qLower.includes('tampak') || qLower.includes('ada apa')) {
      return QueryIntent.CURRENTLY_VISIBLE;
    }

    return QueryIntent.UNKNOWN;
  }

  /**
   * Menjawab pertanyaan memori secara deterministik dan grounded
   * @param {string} question Pertanyaan pengguna
   * @param {import('./ObjectMemory.js').ObjectMemory} objectMemory Instance ObjectMemory aktif
   * @param {Object|null} [personalObjectRegistry=null] Instance PersonalObjectRegistry opsional (V1.2)
   * @returns {{ isMemoryQuery: boolean, intent: string, answer: string, matchedObjects: Array<Object> }}
   */
  static query(question, objectMemory, personalObjectRegistry = null) {
    const qLower = String(question || '').toLowerCase().trim();

    if (!objectMemory || typeof objectMemory.getAllObjects !== 'function') {
      return {
        isMemoryQuery: false,
        intent: QueryIntent.UNKNOWN,
        answer: 'Memori objek VisionX belum aktif atau tidak tersedia.',
        matchedObjects: []
      };
    }

    const isMem = MemoryQueryEngine.isMemoryQuestion(qLower);
    if (!isMem) {
      return {
        isMemoryQuery: false,
        intent: QueryIntent.UNKNOWN,
        answer: '',
        matchedObjects: []
      };
    }

    const intent = MemoryQueryEngine.detectIntent(qLower);
    const { targetClass, targetWord, targetTrackId, isPersonalQuery, personalObjectName } = MemoryQueryEngine.extractTarget(qLower, personalObjectRegistry);
    const allObjects = objectMemory.getAllObjects();
    const activeObjects = objectMemory.getActiveObjects();
    const recentEvents = objectMemory.getRecentEvents(15);
    const now = Date.now();

    // Helper humanized elapsed time
    const formatAgo = (timestamp) => {
      const sec = Math.max(1, Math.round((now - timestamp) / 1000));
      if (sec < 60) return `${sec} detik yang lalu`;
      const min = Math.round(sec / 60);
      return `${min} menit yang lalu`;
    };

    let answer = '';
    let matchedObjects = [];

    switch (intent) {
      // -----------------------------------------------------------------------
      // 1. LAST_SEEN: "Terakhir laptop ada di mana?" / "Kapan laptop terakhir terlihat?"
      // -----------------------------------------------------------------------
      case QueryIntent.LAST_SEEN: {
        // V1.2 Penanganan Kueri Objek Personal ("laptop gw", "mouse gw", "barang gw", dsb.)
        if (isPersonalQuery || personalObjectName) {
          const personalObjs = typeof objectMemory.getPersonalizedObjects === 'function'
            ? objectMemory.getPersonalizedObjects()
            : allObjects.filter(o => o.identityStatus === 'PERSONALIZED' || Boolean(o.personalizedName));

          if (personalObjectName || targetClass) {
            const matches = personalObjs.filter(o => {
              if (personalObjectName && o.personalizedName && o.personalizedName.toLowerCase().includes(personalObjectName.toLowerCase())) return true;
              if (targetClass && o.className && o.className.toLowerCase() === targetClass.toLowerCase()) return true;
              return false;
            }).sort((a, b) => b.lastSeen - a.lastSeen);

            if (matches.length > 0) {
              matchedObjects = matches;
              const latest = matches[0];
              const ago = formatAgo(latest.lastSeen);
              const timeStr = new Date(latest.lastSeen).toLocaleTimeString();
              const stateDesc = latest.state === TrackMemoryState.ACTIVE ? 'sedang aktif terlihat' : 'terakhir terlihat';
              answer = `Objek personal Anda "${latest.personalizedName}" (Track #${latest.trackId}) ${stateDesc} di area ${latest.lastSpatialPosition} pada pukul ${timeStr} (${ago}).`;
            } else if (targetClass) {
              // Cek apakah ada objek generic di memori yang belum terkonfirmasi personal
              const genericMatches = objectMemory.getObjectsByClass(targetClass);
              if (genericMatches.length > 0) {
                const gen = genericMatches[0];
                answer = `Ditemukan objek ${targetClass} #${gen.trackId} di area ${gen.lastSpatialPosition}, namun belum terkonfirmasi cocok sebagai barang personal milik Anda.`;
              } else {
                const displayTerm = personalObjectName || ((targetWord || targetClass) + ' gw');
                answer = `Belum ada riwayat "${displayTerm}" yang tersimpan dalam memori sesi ini.`;
              }
            } else {
              answer = `Belum ada riwayat "${personalObjectName}" yang tersimpan dalam memori sesi ini.`;
            }
          } else {
            // "barang gw terakhir ada di mana?"
            if (personalObjs.length > 0) {
              const latest = [...personalObjs].sort((a, b) => b.lastSeen - a.lastSeen)[0];
              matchedObjects = [latest];
              answer = `Barang personal Anda yang terakhir terlihat adalah "${latest.personalizedName}" (Track #${latest.trackId}) di area ${latest.lastSpatialPosition} (${formatAgo(latest.lastSeen)}).`;
            } else {
              answer = 'Belum ada riwayat barang personal Anda yang tersimpan dalam memori sesi ini.';
            }
          }
          break;
        }

        if (targetTrackId !== null) {
          const obj = allObjects.find(o => o.trackId === targetTrackId);
          if (obj) {
            matchedObjects = [obj];
            const ago = formatAgo(obj.lastSeen);
            const timeStr = new Date(obj.lastSeen).toLocaleTimeString();
            const stateDesc = obj.state === TrackMemoryState.ACTIVE ? 'sedang terlihat aktif' : 'terakhir terlihat';
            answer = `Objek #${obj.trackId} (${obj.className}) ${stateDesc} di area ${obj.lastSpatialPosition} pada pukul ${timeStr} (${ago}).`;
          } else {
            answer = `Tidak ditemukan catatan objek dengan ID #${targetTrackId} dalam memori sesi ini.`;
          }
        } else if (targetClass) {
          const matches = objectMemory.getObjectsByClass(targetClass)
            .sort((a, b) => b.lastSeen - a.lastSeen);

          if (matches.length > 0) {
            matchedObjects = matches;
            const latest = matches[0];
            const ago = formatAgo(latest.lastSeen);
            const timeStr = new Date(latest.lastSeen).toLocaleTimeString();
            const countNote = matches.length > 1 ? ` (terdapat total ${matches.length} ${targetClass} dalam riwayat sesi)` : '';

            if (latest.state === TrackMemoryState.ACTIVE) {
              answer = `${targetClass} (Track #${latest.trackId}) sedang aktif terlihat di area ${latest.lastSpatialPosition} saat ini${countNote}.`;
            } else {
              answer = `${targetClass} (Track #${latest.trackId}) terakhir terlihat di area ${latest.lastSpatialPosition} pada pukul ${timeStr} (${ago})${countNote}.`;
            }
          } else {
            // ZERO HALLUCINATION RESPONSE
            answer = `Belum ada riwayat ${targetClass} yang tersimpan dalam memori sesi ini.`;
          }
        } else {
          // Pertanyaan umum ("apa yang terakhir terlihat?")
          if (allObjects.length > 0) {
            const latest = [...allObjects].sort((a, b) => b.lastSeen - a.lastSeen)[0];
            matchedObjects = [latest];
            const ago = formatAgo(latest.lastSeen);
            answer = `Objek terakhir yang terdeteksi adalah ${latest.className} #${latest.trackId} di area ${latest.lastSpatialPosition} (${ago}).`;
          } else {
            answer = 'Belum ada objek yang tercatat dalam memori sesi VisionX.';
          }
        }
        break;
      }

      // -----------------------------------------------------------------------
      // 2. CURRENTLY_VISIBLE: "Objek apa yang sedang terlihat sekarang?"
      // -----------------------------------------------------------------------
      case QueryIntent.CURRENTLY_VISIBLE: {
        // V1.2 Personalized currently visible
        if (isPersonalQuery || personalObjectName) {
          const activePersonal = activeObjects.filter(o => o.identityStatus === 'PERSONALIZED' || Boolean(o.personalizedName));
          if (personalObjectName || targetClass) {
            const matches = activePersonal.filter(o => {
              if (personalObjectName && o.personalizedName && o.personalizedName.toLowerCase().includes(personalObjectName.toLowerCase())) return true;
              if (targetClass && o.className && o.className.toLowerCase() === targetClass.toLowerCase()) return true;
              return false;
            });
            if (matches.length > 0) {
              matchedObjects = matches;
              answer = `Ya, objek personal Anda "${matches[0].personalizedName}" sedang aktif terlihat di area ${matches[0].lastSpatialPosition}.`;
            } else {
              const displayTerm = personalObjectName || ((targetWord || targetClass) ? (targetWord || targetClass) + ' gw' : 'barang personal');
              answer = `Saat ini tidak ada "${displayTerm}" yang sedang terlihat di depan kamera.`;
            }
          } else {
            if (activePersonal.length > 0) {
              matchedObjects = activePersonal;
              const desc = activePersonal.map(p => `"${p.personalizedName}" di area ${p.lastSpatialPosition}`).join(', ');
              answer = `Barang personal Anda yang sedang aktif terlihat: ${desc}.`;
            } else {
              answer = 'Saat ini tidak ada barang personal Anda yang sedang terlihat di depan kamera.';
            }
          }
          break;
        }

        if (targetClass) {
          const activeMatches = activeObjects.filter(o => o.className.toLowerCase() === targetClass.toLowerCase());
          matchedObjects = activeMatches;
          if (activeMatches.length > 0) {
            const locs = activeMatches.map(m => `#${m.trackId} di area ${m.lastSpatialPosition}`).join(', ');
            answer = `Ya, ada ${activeMatches.length} ${targetClass} yang sedang terlihat: ${locs}.`;
          } else {
            const pastMatches = objectMemory.getObjectsByClass(targetClass);
            if (pastMatches.length > 0) {
              const latest = pastMatches.sort((a, b) => b.lastSeen - a.lastSeen)[0];
              answer = `Saat ini tidak ada ${targetClass} yang aktif di depan kamera. Terakhir terlihat #${latest.trackId} di area ${latest.lastSpatialPosition} (${formatAgo(latest.lastSeen)}).`;
            } else {
              answer = `Tidak ada ${targetClass} yang sedang terlihat di depan kamera saat ini.`;
            }
          }
        } else {
          if (activeObjects.length > 0) {
            matchedObjects = activeObjects;
            const desc = activeObjects.map(o => `${o.className} #${o.trackId} (${o.lastSpatialPosition})`).join(', ');
            answer = `Saat ini ada ${activeObjects.length} objek aktif di depan kamera: ${desc}.`;
          } else {
            answer = 'Saat ini tidak ada objek yang aktif terlihat di depan kamera.';
          }
        }
        break;
      }

      // -----------------------------------------------------------------------
      // 3. COUNT: "Berapa kali mouse terdeteksi?" / "Berapa laptop yang terlihat?"
      // -----------------------------------------------------------------------
      case QueryIntent.COUNT: {
        if (isPersonalQuery || personalObjectName) {
          const personalObjs = typeof objectMemory.getPersonalizedObjects === 'function'
            ? objectMemory.getPersonalizedObjects()
            : allObjects.filter(o => o.identityStatus === 'PERSONALIZED' || Boolean(o.personalizedName));

          if (personalObjectName || targetClass) {
            const matches = personalObjs.filter(o => {
              if (personalObjectName && o.personalizedName && o.personalizedName.toLowerCase().includes(personalObjectName.toLowerCase())) return true;
              if (targetClass && o.className && o.className.toLowerCase() === targetClass.toLowerCase()) return true;
              return false;
            });
            matchedObjects = matches;
            answer = `Tercatat ${matches.length} objek personal "${personalObjectName || (targetClass + ' gw')}" dalam memori sesi ini.`;
          } else {
            matchedObjects = personalObjs;
            answer = `Tercatat total ${personalObjs.length} barang personal berbeda dalam memori sesi ini.`;
          }
          break;
        }

        if (targetClass) {
          const allClassObjects = objectMemory.getObjectsByClass(targetClass);
          const activeClassObjects = activeObjects.filter(o => o.className.toLowerCase() === targetClass.toLowerCase());
          matchedObjects = allClassObjects;

          if (allClassObjects.length > 0) {
            answer = `Tercatat ${allClassObjects.length} objek ${targetClass} dalam sesi ini (${activeClassObjects.length} sedang aktif terlihat saat ini).`;
          } else {
            answer = `Belum pernah terdeteksi ${targetClass} dalam sesi pengamatan ini.`;
          }
        } else {
          answer = `Total ada ${allObjects.length} objek berbeda yang pernah tercatat dalam memori (${activeObjects.length} aktif saat ini).`;
        }
        break;
      }

      // -----------------------------------------------------------------------
      // 4. ENTERED: "Objek apa yang baru masuk?"
      // -----------------------------------------------------------------------
      case QueryIntent.ENTERED: {
        const enteredEvents = recentEvents.filter(e => e.type === 'OBJECT_ENTERED');
        if (enteredEvents.length > 0) {
          const latest = enteredEvents[0];
          answer = `Objek yang baru masuk adalah ${latest.className} #${latest.trackId} di area ${latest.zone} (${formatAgo(latest.timestamp)}).`;
        } else if (activeObjects.length > 0) {
          const latest = [...activeObjects].sort((a, b) => b.firstSeen - a.firstSeen)[0];
          answer = `Objek yang paling baru terdeteksi adalah ${latest.className} #${latest.trackId} di area ${latest.lastSpatialPosition}.`;
        } else {
          answer = 'Belum ada rekaman objek baru yang masuk baru-baru ini.';
        }
        break;
      }

      // -----------------------------------------------------------------------
      // 5. LEFT: "Objek apa yang baru hilang / keluar?"
      // -----------------------------------------------------------------------
      case QueryIntent.LEFT: {
        const leftEvents = recentEvents.filter(e => e.type === 'OBJECT_LEFT');
        if (leftEvents.length > 0) {
          const latest = leftEvents[0];
          answer = `Objek yang baru saja hilang dari pandangan adalah ${latest.className} #${latest.trackId} (terakhir terlihat di area ${latest.zone} sekitar ${formatAgo(latest.timestamp)}).`;
        } else {
          const leftObjects = allObjects.filter(o => o.state === TrackMemoryState.LEFT)
            .sort((a, b) => b.lastSeen - a.lastSeen);
          if (leftObjects.length > 0) {
            const latest = leftObjects[0];
            answer = `Objek terakhir yang meninggalkan kamera adalah ${latest.className} #${latest.trackId} di area ${latest.lastSpatialPosition} (${formatAgo(latest.lastSeen)}).`;
          } else {
            answer = 'Tidak ada objek yang tercatat baru saja hilang dari kamera.';
          }
        }
        break;
      }

      // -----------------------------------------------------------------------
      // 6. RETURNED: "Objek apa yang kembali?"
      // -----------------------------------------------------------------------
      case QueryIntent.RETURNED: {
        const returnEvents = recentEvents.filter(e => e.type === 'OBJECT_RETURNED');
        if (returnEvents.length > 0) {
          const latest = returnEvents[0];
          answer = `Objek yang baru saja kembali adalah ${latest.className} #${latest.trackId} di area ${latest.zone} (${formatAgo(latest.timestamp)}).`;
        } else {
          answer = 'Belum ada objek yang tercatat hilang lalu kembali lagi dalam sesi ini.';
        }
        break;
      }

      // -----------------------------------------------------------------------
      // 7. HISTORY: "Riwayat laptop"
      // -----------------------------------------------------------------------
      case QueryIntent.HISTORY:
      default: {
        if (targetClass) {
          const historyObjs = objectMemory.getObjectsByClass(targetClass);
          matchedObjects = historyObjs;
          if (historyObjs.length > 0) {
            const summary = historyObjs.map(o => `#${o.trackId} (${o.lastSpatialPosition}, ${o.state})`).join(', ');
            answer = `Riwayat untuk ${targetClass}: terdapat ${historyObjs.length} objek yang pernah terdeteksi [${summary}].`;
          } else {
            answer = `Belum ada riwayat ${targetClass} yang tersimpan dalam memori sesi ini.`;
          }
        } else {
          const stats = objectMemory.getStats();
          answer = `Memori sesi VisionX mencatat total ${stats.totalRecords} objek unik dan ${stats.totalEvents} event histori (${stats.activeCount} objek aktif saat ini).`;
        }
        break;
      }
    }

    return {
      isMemoryQuery: true,
      intent,
      answer,
      matchedObjects
    };
  }
}
