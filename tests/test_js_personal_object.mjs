/**
 * test_js_personal_object.mjs - Automated Unit Tests for VisionX V1.2 Personalized Recognition
 */

import { PersonalObjectRegistry } from '../web/src/services/PersonalObjectRegistry.js';
import { PersonalObjectRecognizer, PersonalIdentityStatus } from '../web/src/services/PersonalObjectRecognizer.js';
import { ObjectEnrollment } from '../web/src/services/ObjectEnrollment.js';
import { ObjectMemory } from '../web/src/services/ObjectMemory.js';
import { MemoryQueryEngine } from '../web/src/services/MemoryQueryEngine.js';

class MockStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

// Helper: Buat dummy 128-d unit vector
function createNormalizedVector(seed = 1) {
  const vec = new Array(128);
  let sumSq = 0;
  for (let i = 0; i < 128; i++) {
    const val = Math.sin(seed * (i + 1)) * 0.5 + 0.5;
    vec[i] = val;
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq) + 1e-7;
  return vec.map(v => Math.round((v / norm) * 10000) / 10000);
}

// Helper: Tambahkan noise ke vector
function addNoiseToVector(baseVec, noiseMagnitude = 0.05) {
  const vec = baseVec.map((v, i) => v + (Math.sin(i * 3.7) * noiseMagnitude));
  let sumSq = 0;
  for (let i = 0; i < 128; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) + 1e-7;
  return vec.map(v => Math.round((v / norm) * 10000) / 10000);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('🏷 Running VisionX V1.2 Personalized Recognition Test Suite');
  console.log('================================================================\n');

  let passed = 0;
  const mockStorage = new MockStorage();

  // Test 1: Register Object
  {
    process.stdout.write('• Testing: Register Object - Pendaftaran objek personal baru... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const enrollment = new ObjectEnrollment(registry);

    const refVec = createNormalizedVector(1.0);
    const obj = await enrollment.enrollObject({
      name: 'My Laptop',
      baseClass: 'laptop',
      references: [
        { id: 'ref_1', angle: 'front', embedding: refVec },
        { id: 'ref_2', angle: 'top', embedding: addNoiseToVector(refVec, 0.02) }
      ],
      threshold: 0.75
    });

    assert(obj.id && obj.id.startsWith('po_'), 'Objek harus memiliki ID valid');
    assert(obj.name === 'My Laptop', 'Nama objek harus tersimpan');
    assert(obj.baseClass === 'laptop', 'Base class harus laptop');
    assert(obj.references.length === 2, 'Harus menyimpan 2 foto referensi');
    assert(obj.embeddingMetadata.referenceCount === 2, 'Metadata count harus 2');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 2: Duplicate Handling
  {
    process.stdout.write('• Testing: Duplicate Handling - Menolak nama objek yang duplikat... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const enrollment = new ObjectEnrollment(registry);

    let threw = false;
    try {
      await enrollment.enrollObject({
        name: 'My Laptop', // Nama yang sama dengan Test 1
        baseClass: 'laptop',
        references: [{ id: 'ref_3', angle: 'front', embedding: createNormalizedVector(2.0) }]
      });
    } catch (e) {
      threw = true;
      assert(e.message.includes('sudah terdaftar'), 'Pesan error harus menyebutkan duplikasi');
    }

    assert(threw, 'Harus melempar error saat nama duplikat');
    console.log('✅ PASSED');
    passed++;
  }

  // Test 3: Invalid Class Validation
  {
    process.stdout.write('• Testing: Invalid Class - Menolak kelas yang tidak didukung YOLO... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const enrollment = new ObjectEnrollment(registry);

    let threw = false;
    try {
      await enrollment.enrollObject({
        name: 'My Spaceship',
        baseClass: 'spaceship_unsupported_class',
        references: [{ id: 'ref_1', angle: 'front', embedding: createNormalizedVector(3.0) }]
      });
    } catch (e) {
      threw = true;
      assert(e.message.includes('tidak termasuk dalam daftar kelas'), 'Harus menjelaskan kelas tidak didukung');
    }

    assert(threw, 'Harus menolak kelas tidak didukung');
    console.log('✅ PASSED');
    passed++;
  }

  // Test 4: Reference Management (Add & Remove Reference)
  {
    process.stdout.write('• Testing: Reference Management - Tambah dan hapus foto referensi... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const enrollment = new ObjectEnrollment(registry);

    const obj = registry.findByName('My Laptop');
    assert(obj, 'Objek harus ditemukan');

    const newRef = await enrollment.addReferenceToExisting(obj.id, {
      angle: 'side',
      precomputedEmbedding: createNormalizedVector(1.05)
    });

    assert(newRef && newRef.angle === 'side', 'Referensi baru harus tersimpan');
    assert(obj.references.length === 3, 'Referensi bertambah menjadi 3');

    // Hapus referensi
    const removed = registry.removeReference(obj.id, newRef.id);
    assert(removed === true, 'Referensi berhasil dihapus');
    assert(obj.references.length === 2, 'Referensi kembali menjadi 2');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 5: Visual Similarity Matching
  {
    process.stdout.write('• Testing: Visual Matching - Mencocokkan deteksi visual ke identitas personal... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const recognizer = new PersonalObjectRecognizer(registry);

    const refVec = registry.findByName('My Laptop').references[0].embedding;
    const testCropVec = addNoiseToVector(refVec, 0.03); // Sangat mirip (~0.98 similarity)

    const result = recognizer.recognizeDetection(
      { class_name: 'laptop', bbox: [100, 100, 300, 300] },
      testCropVec
    );

    assert(result.identityStatus === PersonalIdentityStatus.PERSONALIZED, 'Status harus PERSONALIZED');
    assert(result.personalizedName === 'My Laptop', 'Nama harus My Laptop');
    assert(result.matchConfidence >= 0.75, 'Confidence harus di atas threshold');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 6: Threshold Rejection (Possible Match)
  {
    process.stdout.write('• Testing: Threshold Rejection - Kemiripan medium masuk ke possible match... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const recognizer = new PersonalObjectRecognizer(registry);

    const refVec = registry.findByName('My Laptop').references[0].embedding;
    // Beri noise sehingga similarity sekitar 0.65 - 0.70 (di bawah 0.75, di atas 0.60)
    const mediumVec = addNoiseToVector(refVec, 0.20);

    const result = recognizer.recognizeDetection(
      { class_name: 'laptop', bbox: [100, 100, 300, 300] },
      mediumVec
    );

    assert(result.identityStatus === PersonalIdentityStatus.UNKNOWN_MATCH, 'Status harus UNKNOWN_MATCH');
    assert(result.personalizedName.includes('possible match'), 'Label harus mengandung possible match');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 7: Zero Forced Match (Dissimilar Object)
  {
    process.stdout.write('• Testing: Zero Forced Match - Objek tidak mirip tetap berstatus GENERIC... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const recognizer = new PersonalObjectRecognizer(registry);

    // Vector orthogonal / completely dissimilar (0.0 similarity)
    const dissimilarVec = new Array(128).fill(0);
    for (let i = 64; i < 128; i++) dissimilarVec[i] = 1.0 / Math.sqrt(64);

    const refVec = registry.findByName('My Laptop').references[0].embedding;

    const result = recognizer.recognizeDetection(
      { class_name: 'laptop', bbox: [100, 100, 300, 300] },
      dissimilarVec
    );

    assert(result.identityStatus === PersonalIdentityStatus.GENERIC, 'Status harus GENERIC');
    assert(result.personalizedName === null, 'Nama personal harus null');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 8: Multiple Personalized Objects
  {
    process.stdout.write('• Testing: Multiple Objects - Mengenali beberapa objek personal dari kelas berbeda... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const enrollment = new ObjectEnrollment(registry);
    const recognizer = new PersonalObjectRecognizer(registry);

    const mouseVec = createNormalizedVector(5.0);
    await enrollment.enrollObject({
      name: 'Mouse Merah',
      baseClass: 'mouse',
      references: [{ id: 'ref_m1', angle: 'top', embedding: mouseVec }]
    });

    const laptopRes = recognizer.recognizeDetection(
      { class_name: 'laptop', bbox: [50, 50, 200, 200] },
      registry.findByName('My Laptop').references[0].embedding
    );
    const mouseRes = recognizer.recognizeDetection(
      { class_name: 'mouse', bbox: [300, 300, 400, 400] },
      mouseVec
    );

    assert(laptopRes.personalizedName === 'My Laptop', 'Laptop harus dikenali');
    assert(mouseRes.personalizedName === 'Mouse Merah', 'Mouse harus dikenali');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 9: Track Identity Persistence & Throttling
  {
    process.stdout.write('• Testing: Track Identity Caching - Identitas melekat pada Track ID dan di-cache... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const recognizer = new PersonalObjectRecognizer(registry);

    const laptopRef = registry.findByName('My Laptop').references[0].embedding;

    // Track frame 1: Inferensi pertama
    const track1 = {
      trackId: 1,
      className: 'laptop',
      bbox: [100, 100, 300, 300]
    };

    // Mock embedding extractor pada track pertama
    const originalRecognize = recognizer.recognizeDetection.bind(recognizer);
    let inferenceCallCount = 0;
    recognizer.recognizeDetection = (det, emb, src) => {
      inferenceCallCount++;
      return originalRecognize(det, laptopRef, src);
    };

    recognizer.processTracks([track1]);
    assert(track1.personalizedName === 'My Laptop', 'Track 1 harus beridentitas My Laptop');
    assert(inferenceCallCount === 1, 'Harus memanggil pengenalan 1 kali');

    // Track frame 2: Dalam periode throttling (<1500ms)
    const track1Frame2 = {
      trackId: 1,
      className: 'laptop',
      bbox: [105, 105, 305, 305]
    };
    recognizer.processTracks([track1Frame2]);
    assert(track1Frame2.personalizedName === 'My Laptop', 'Track 1 frame 2 harus menggunakan cache');
    assert(inferenceCallCount === 1, 'Inference TIDAK boleh dipanggil ulang dalam cooldown (throtled)');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 10: Memory Integration
  {
    process.stdout.write('• Testing: Memory Integration - ObjectMemory mencatat data identitas personal... ');
    const memory = new ObjectMemory({ storage: mockStorage, storageKey: 'test_mem_po' });

    memory.update([
      {
        trackId: 1,
        className: 'laptop',
        personalizedName: 'My Laptop',
        identityStatus: 'PERSONALIZED',
        matchConfidence: 0.94,
        bbox: [100, 100, 300, 300]
      }
    ], { width: 640, height: 480 });

    const personalObjs = memory.getPersonalizedObjects();
    assert(personalObjs.length === 1, 'Harus ada 1 objek personal di memori');
    assert(personalObjs[0].personalizedName === 'My Laptop', 'Nama personal harus tersimpan');
    assert(personalObjs[0].identityStatus === 'PERSONALIZED', 'Status harus tersimpan');

    const recentEvents = memory.getRecentEvents(5);
    assert(recentEvents.length > 0, 'Harus ada event tercatat');
    assert(recentEvents[0].description.includes('My Laptop'), 'Deskripsi event harus mencakup nama personal');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 11: Query Personalized Object (MemoryQueryEngine)
  {
    process.stdout.write('• Testing: Query Personalized - Menjawab pertanyaan seputar barang personal... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const memory = new ObjectMemory({ storage: mockStorage, storageKey: 'test_mem_po' });

    memory.update([
      {
        trackId: 1,
        className: 'laptop',
        personalizedName: 'My Laptop',
        identityStatus: 'PERSONALIZED',
        matchConfidence: 0.95,
        bbox: [450, 100, 600, 300] // Kanan
      }
    ], { width: 640, height: 480 });

    // 1. Kueri nama personal eksplisit
    const q1 = MemoryQueryEngine.query('kapan laptop gw terakhir terlihat?', memory, registry);
    assert(q1.isMemoryQuery === true, 'Harus terdeteksi sebagai memory query');
    assert(q1.answer.includes('My Laptop'), 'Jawaban harus menyebutkan My Laptop');
    assert(q1.answer.includes('kanan'), 'Jawaban harus menyebutkan area kanan');

    // 2. Kueri barang yang belum pernah terlihat (Zero Hallucination)
    const q2 = MemoryQueryEngine.query('di mana botol gw?', memory, registry);
    assert(q2.answer.includes('Belum ada riwayat "botol gw"'), 'Harus menolak mengarang botol gw');

    // 3. Kueri barang-barang yang sedang terlihat
    const q3 = MemoryQueryEngine.query('barang gw apa saja yang terlihat?', memory, registry);
    assert(q3.answer.includes('My Laptop'), 'Harus mencantumkan My Laptop');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 12: Delete & Disable Control
  {
    process.stdout.write('• Testing: Delete & Disable - Objek nonaktif tidak lagi dicocokkan... ');
    const registry = new PersonalObjectRegistry({ storage: mockStorage, storageKey: 'test_po_1' });
    const recognizer = new PersonalObjectRecognizer(registry);

    const obj = registry.findByName('My Laptop');
    assert(obj.enabled === true, 'Awalnya harus aktif');

    // Nonaktifkan
    registry.setEnabled(obj.id, false);
    recognizer.resetCache();

    const disabledRes = recognizer.recognizeDetection(
      { class_name: 'laptop', bbox: [100, 100, 300, 300] },
      obj.references[0].embedding
    );
    assert(disabledRes.identityStatus === PersonalIdentityStatus.GENERIC, 'Saat disabled harus GENERIC');

    // Aktifkan kembali
    registry.setEnabled(obj.id, true);
    recognizer.resetCache();
    const enabledRes = recognizer.recognizeDetection(
      { class_name: 'laptop', bbox: [100, 100, 300, 300] },
      obj.references[0].embedding
    );
    assert(enabledRes.identityStatus === PersonalIdentityStatus.PERSONALIZED, 'Saat enabled harus PERSONALIZED');

    // Hapus objek
    registry.delete(obj.id);
    assert(registry.findByName('My Laptop') === null, 'Objek harus terhapus dari registry');

    console.log('✅ PASSED');
    passed++;
  }

  // Test 13: Local Persistence Roundtrip
  {
    process.stdout.write('• Testing: Persistence - Simpan dan muat kembali dari storage lokal... ');
    const storageKey = 'test_po_roundtrip';
    const reg1 = new PersonalObjectRegistry({ storage: mockStorage, storageKey });
    reg1.register({
      name: 'Buku Favorit',
      baseClass: 'book',
      references: [{ id: 'ref_b1', angle: 'front', embedding: createNormalizedVector(7.7) }]
    });

    // Buat registry baru dengan storage yang sama
    const reg2 = new PersonalObjectRegistry({ storage: mockStorage, storageKey });
    const loaded = reg2.findByName('Buku Favorit');

    assert(loaded !== null, 'Data harus tersimpan dan dapat dimuat kembali');
    assert(loaded.baseClass === 'book', 'Base class harus sesuai');
    assert(loaded.references.length === 1, 'Foto referensi harus utuh');

    console.log('✅ PASSED');
    passed++;
  }

  console.log('\n================================================================');
  console.log(`🏁 Test Summary: ${passed} PASSED, 0 FAILED`);
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('[TEST SUITE CRASHED]', err);
  process.exit(1);
});
