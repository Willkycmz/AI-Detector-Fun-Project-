/**
 * test_js_object_memory.mjs - Automated Unit Tests for VisionX V1.1 Object Memory & MemoryQueryEngine
 *
 * Verifikasi Skenario Inti:
 * 1. Track creation (firstSeen, trackId, className, initial spatial zone)
 * 2. Update throttling (tidak spamming event setiap frame)
 * 3. firstSeen & lastSeen timestamp tracking
 * 4. Spatial zone calculation (kiri, tengah, kanan, atas, bawah)
 * 5. Multiple objects tracking & lifecycle
 * 6. Left event (OBJECT_LEFT saat track hilang melebihi timeout)
 * 7. Returned event (OBJECT_RETURNED saat track muncul kembali)
 * 8. Clear memory (menghapus objek, event, dan storage)
 * 9. Query last seen ("kapan laptop terakhir terlihat?", "laptop terakhir ada di mana?")
 * 10. Query count ("berapa kali mouse terdeteksi?", "total laptop")
 * 11. Query currently visible ("apa yang sedang terlihat?", "apakah ada botol sekarang?")
 * 12. No hallucinated memory (menjawab jujur saat objek belum pernah tercatat)
 */

import { ObjectMemory, MemoryEventType, TrackMemoryState } from '../web/src/services/ObjectMemory.js';
import { MemoryQueryEngine, QueryIntent } from '../web/src/services/MemoryQueryEngine.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

// Mock localStorage untuk Node.js environment
const mockStorage = new Map();
global.window = {
  localStorage: {
    getItem: (key) => mockStorage.get(key) || null,
    setItem: (key, val) => mockStorage.set(key, String(val)),
    removeItem: (key) => mockStorage.delete(key),
    clear: () => mockStorage.clear()
  }
};

async function runTests() {
  console.log('================================================================');
  console.log('🧠 Running VisionX V1.1 Object Memory & Query Engine Test Suite');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function testCase(name, fn) {
    process.stdout.write(`• Testing: ${name}... `);
    try {
      await fn();
      console.log('✅ PASSED');
      passed++;
    } catch (err) {
      console.log('❌ FAILED');
      console.error(`  Error: ${err.message}`);
      if (err.stack) console.error(`  Stack: ${err.stack.split('\n').slice(1, 3).join('\n')}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // Test 1: Track Creation
  // -------------------------------------------------------------------------
  await testCase('Track Creation - Merekam objek baru dengan firstSeen dan initial zone', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false });
    const tracks = [
      { trackId: 1, className: 'laptop', bbox: [500, 350, 620, 470], confidence: 0.92 }
    ];

    memory.update(tracks, { frameWidth: 640, frameHeight: 480 });

    const obj = memory.knownObjects.get(1);
    assert(obj !== undefined, 'Track #1 harus ada dalam knownObjects');
    assert(obj.className === 'laptop', 'Class name harus laptop');
    assert(typeof obj.firstSeen === 'number', 'firstSeen harus number timestamp');
    assert(obj.lastSpatialPosition === 'kanan bawah', 'Zona harus kanan bawah');
    assert(obj.state === TrackMemoryState.ACTIVE, 'State awal harus ACTIVE');
    assert(memory.eventHistory.length === 1, 'Harus ada 1 event history');
    assert(memory.eventHistory[0].type === MemoryEventType.OBJECT_ENTERED, 'Event harus OBJECT_ENTERED');
  });

  // -------------------------------------------------------------------------
  // Test 2: Update Throttling
  // -------------------------------------------------------------------------
  await testCase('Update Throttling - Tidak spamming event pada posisi dan objek yang sama', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false, updateThrottleMs: 1000 });
    const tracks = [
      { trackId: 2, className: 'mouse', bbox: [300, 200, 340, 240], confidence: 0.88 }
    ];

    // Frame 1: Masuk
    memory.update(tracks, { frameWidth: 640, frameHeight: 480 });
    const countAfterEnter = memory.eventHistory.length;
    assert(countAfterEnter === 1, 'Event pertama adalah OBJECT_ENTERED');

    // Frame 2, 3, 4 pada posisi yang sama dalam window < 1000ms
    memory.update(tracks, { frameWidth: 640, frameHeight: 480 });
    memory.update(tracks, { frameWidth: 640, frameHeight: 480 });
    memory.update(tracks, { frameWidth: 640, frameHeight: 480 });

    assert(memory.eventHistory.length === 1, 'Throttling berhasil mencegah event spam');
  });

  // -------------------------------------------------------------------------
  // Test 3: Spatial Zone Mapping
  // -------------------------------------------------------------------------
  await testCase('Spatial Zone - Konversi bounding box ke zona spasial relatif', () => {
    // Kiri atas: [20, 20, 100, 100] pada frame 640x480
    const zoneKiriAtas = ObjectMemory.getSpatialZone([20, 20, 100, 100], 640, 480);
    assert(zoneKiriAtas === 'kiri atas', `Harus 'kiri atas', didapat '${zoneKiriAtas}'`);

    // Tengah: [280, 200, 360, 280]
    const zoneTengah = ObjectMemory.getSpatialZone([280, 200, 360, 280], 640, 480);
    assert(zoneTengah === 'tengah', `Harus 'tengah', didapat '${zoneTengah}'`);

    // Kanan: [500, 200, 600, 280]
    const zoneKanan = ObjectMemory.getSpatialZone([500, 200, 600, 280], 640, 480);
    assert(zoneKanan === 'kanan', `Harus 'kanan', didapat '${zoneKanan}'`);
  });

  // -------------------------------------------------------------------------
  // Test 4: Multiple Objects Lifecycle
  // -------------------------------------------------------------------------
  await testCase('Multiple Objects - Melacak beberapa objek berbeda secara bersamaan', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false });
    const tracks = [
      { trackId: 10, className: 'laptop', bbox: [100, 100, 200, 200] },
      { trackId: 20, className: 'mouse', bbox: [300, 300, 350, 350] },
      { trackId: 30, className: 'bottle', bbox: [500, 100, 550, 300] }
    ];

    memory.update(tracks, { frameWidth: 640, frameHeight: 480 });

    assert(memory.knownObjects.size === 3, 'Harus mencatat 3 objek');
    assert(memory.getActiveObjects().length === 3, 'Ketiga objek harus aktif');
    assert(memory.getObjectsByClass('laptop').length === 1, 'Harus ada 1 laptop');
    assert(memory.getObjectsByClass('mouse').length === 1, 'Harus ada 1 mouse');
    assert(memory.getObjectsByClass('bottle').length === 1, 'Harus ada 1 bottle');
  });

  // -------------------------------------------------------------------------
  // Test 5: Left Event (OBJECT_LEFT)
  // -------------------------------------------------------------------------
  await testCase('Left Event - Mendeteksi objek yang meninggalkan frame kamera', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false, leftTimeoutMs: 50 });
    const tracks = [{ trackId: 42, className: 'cup', bbox: [200, 200, 250, 250] }];

    // Frame 1: Objek hadir
    memory.update(tracks);
    assert(memory.knownObjects.get(42).state === TrackMemoryState.ACTIVE, 'Objek #42 harus ACTIVE');

    // Simulasikan objek hilang selama > 50ms
    const startWait = Date.now();
    while (Date.now() - startWait < 60) {}

    // Frame 2: Objek tidak ada lagi dalam frame
    memory.update([]);

    const obj = memory.knownObjects.get(42);
    assert(obj.state === TrackMemoryState.LEFT, 'Objek #42 harus ditandai LEFT');
    assert(memory.eventHistory.some(e => e.type === MemoryEventType.OBJECT_LEFT), 'Event OBJECT_LEFT harus tercatat');
  });

  // -------------------------------------------------------------------------
  // Test 6: Returned Event (OBJECT_RETURNED)
  // -------------------------------------------------------------------------
  await testCase('Returned Event - Mendeteksi objek yang kembali terlihat setelah hilang', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false, leftTimeoutMs: 10 });
    const tracks = [{ trackId: 55, className: 'pen', bbox: [100, 100, 120, 200] }];

    memory.update(tracks);

    // Objek hilang
    const startWait = Date.now();
    while (Date.now() - startWait < 20) {}
    memory.update([]);
    assert(memory.knownObjects.get(55).state === TrackMemoryState.LEFT, 'Objek harus LEFT');

    // Objek kembali
    memory.update(tracks);
    const obj = memory.knownObjects.get(55);
    assert(obj.state === TrackMemoryState.ACTIVE, 'Objek kembali ACTIVE');
    assert(memory.eventHistory[0].type === MemoryEventType.OBJECT_RETURNED, 'Event terbaru harus OBJECT_RETURNED');
  });

  // -------------------------------------------------------------------------
  // Test 7: Memory Persistence & Clear Memory
  // -------------------------------------------------------------------------
  await testCase('Persistence & Clear - Simpan ke storage dan bersihkan sesi memori', () => {
    mockStorage.clear();
    const memory1 = new ObjectMemory({ storageKey: 'test_mem_key', enableStoragePersistence: true });
    memory1.update([{ trackId: 99, className: 'phone', bbox: [50, 50, 100, 150] }]);
    memory1.saveToStorage();

    assert(mockStorage.has('test_mem_key'), 'Storage harus menyimpan serialisasi memori');

    // Instance baru memuat data sebelumnya
    const memory2 = new ObjectMemory({ storageKey: 'test_mem_key', enableStoragePersistence: true });
    assert(memory2.knownObjects.has(99), 'Memory2 harus memuat track #99 dari storage');
    assert(memory2.knownObjects.get(99).className === 'phone', 'Class name harus phone');

    // Clear memory
    memory2.clear();
    assert(memory2.knownObjects.size === 0, 'knownObjects harus kosong setelah clear');
    assert(memory2.eventHistory.length === 0, 'eventHistory harus kosong setelah clear');
    assert(!mockStorage.has('test_mem_key'), 'Storage key harus terhapus setelah clear');
  });

  // -------------------------------------------------------------------------
  // Test 8: MemoryQueryEngine - Query LAST_SEEN
  // -------------------------------------------------------------------------
  await testCase('QueryEngine LAST_SEEN - Menjawab posisi terakhir objek dengan akurat', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false });
    memory.update([
      { trackId: 7, className: 'laptop', bbox: [500, 100, 600, 200] } // kanan atas
    ]);

    const res1 = MemoryQueryEngine.query('Kapan laptop terakhir terlihat?', memory);
    assert(res1.isMemoryQuery === true, 'Harus terdeteksi sebagai memory query');
    assert(res1.intent === QueryIntent.LAST_SEEN, 'Intent harus LAST_SEEN');
    assert(res1.answer.includes('laptop') && res1.answer.includes('Track #7'), 'Jawaban menyebutkan laptop dan track');
    assert(res1.answer.includes('kanan atas'), 'Jawaban menyebutkan posisi kanan atas');

    const res2 = MemoryQueryEngine.query('Laptop terakhir ada di mana?', memory);
    assert(res2.isMemoryQuery === true, 'Harus terdeteksi sebagai memory query');
    assert(res2.answer.includes('kanan atas'), 'Jawaban menyebutkan area kanan atas');
  });

  // -------------------------------------------------------------------------
  // Test 9: MemoryQueryEngine - Query COUNT
  // -------------------------------------------------------------------------
  await testCase('QueryEngine COUNT - Menghitung jumlah objek yang tercatat', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false });
    memory.update([
      { trackId: 1, className: 'mouse', bbox: [100, 100, 150, 150] },
      { trackId: 2, className: 'mouse', bbox: [200, 200, 250, 250] }
    ]);

    const res = MemoryQueryEngine.query('Berapa kali mouse terdeteksi?', memory);
    assert(res.isMemoryQuery === true, 'Harus terdeteksi memory query');
    assert(res.intent === QueryIntent.COUNT, 'Intent harus COUNT');
    assert(res.answer.includes('2 objek mouse'), `Jawaban harus menyatakan 2 mouse: "${res.answer}"`);
  });

  // -------------------------------------------------------------------------
  // Test 10: MemoryQueryEngine - Query CURRENTLY_VISIBLE
  // -------------------------------------------------------------------------
  await testCase('QueryEngine CURRENTLY_VISIBLE - Menjawab objek yang sedang aktif terlihat', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false });
    memory.update([
      { trackId: 5, className: 'bottle', bbox: [300, 200, 350, 300] } // tengah
    ]);

    const res = MemoryQueryEngine.query('Objek apa yang sedang terlihat sekarang?', memory);
    assert(res.isMemoryQuery === true, 'Harus terdeteksi memory query');
    assert(res.answer.includes('bottle #5'), 'Menyebutkan bottle #5 aktif');
    assert(res.answer.includes('tengah'), 'Menyebutkan posisi tengah');
  });

  // -------------------------------------------------------------------------
  // Test 11: MemoryQueryEngine - ZERO HALLUCINATION GUARANTEE
  // -------------------------------------------------------------------------
  await testCase('Zero Hallucination - Menolak mengarang riwayat objek yang belum pernah terlihat', () => {
    const memory = new ObjectMemory({ enableStoragePersistence: false });
    memory.update([
      { trackId: 1, className: 'pen', bbox: [100, 100, 120, 150] }
    ]);

    // Tanyakan tentang laptop (yang tidak pernah ada dalam memori)
    const res = MemoryQueryEngine.query('Terakhir laptop ada di mana?', memory);
    assert(res.isMemoryQuery === true, 'Harus terdeteksi memory query');
    assert(res.answer.includes('Belum ada riwayat laptop'), `Jawaban jujur tanpa karangan: "${res.answer}"`);
    assert(!res.answer.includes('kiri') && !res.answer.includes('kanan'), 'Tidak boleh mengarang lokasi fiktif');
  });

  console.log('\n================================================================');
  console.log(`🏁 Test Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
