/**
 * test_js_conversational_vision.mjs - Unit Test Suite for VisionX V1.6 Phase D
 * Multi-Turn Conversational Vision & Grounded Reference Resolution
 */

import assert from 'assert';
import { ConversationManager } from '../web/src/services/ConversationManager.js';
import { VisionAssistant, AssistantState } from '../web/src/services/VisionAssistant.js';
import { MockAIProvider } from '../web/src/services/AIProvider.js';
import { SceneHistoryEngine } from '../web/src/services/SceneHistoryEngine.js';

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

async function runTests() {
  console.log('================================================================');
  console.log('💬 Running VisionX V1.6 Phase D — Conversational Vision Tests');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // Test 1: createSession and clear
  // -------------------------------------------------------------------------
  await testCase('Session Lifecycle - createSession dan clear', () => {
    const cm = new ConversationManager();
    const sess1 = cm.sessionId;
    assert(sess1 && sess1.startsWith('sess_'), 'Session ID awal harus valid');

    cm.appendUserMessage('Halo');
    cm.appendAssistantMessage('Halo, ada yang bisa dibantu?');
    assert.strictEqual(cm.getAllTurns().length, 2, 'Harus ada 2 turn');

    cm.clear();
    assert.strictEqual(cm.getAllTurns().length, 0, 'Clear harus mengosongkan turns');
    assert.notStrictEqual(cm.sessionId, sess1, 'Clear harus menghasilkan session ID baru');

    const customId = 'custom_sess_123';
    cm.createSession(customId);
    assert.strictEqual(cm.sessionId, customId, 'createSession harus menerima custom session ID');
  });

  // -------------------------------------------------------------------------
  // Test 2: appendUserMessage
  // -------------------------------------------------------------------------
  await testCase('Append User Turn - Menyimpan pesan pengguna dengan contextRef', () => {
    const cm = new ConversationManager();
    const mockContext = {
      timestamp: 1700000000000,
      summary: { focal_object: 'laptop', total_objects: 1 },
      detections: [
        { id: 1, class_name: 'laptop', relative_position: 'tengah', bbox: [100, 100, 300, 300] }
      ]
    };

    const turn = cm.appendUserMessage('Apa yang ada di depan?', mockContext);
    assert.strictEqual(turn.role, 'user', 'Role harus user');
    assert.strictEqual(turn.content, 'Apa yang ada di depan?', 'Konten harus sesuai');
    assert(turn.contextRef !== null, 'contextRef harus terekstraksi');
    assert.strictEqual(turn.contextRef.totalObjects, 1, 'totalObjects contextRef harus 1');
    assert.strictEqual(turn.contextRef.detectedClasses[0], 'laptop', 'Kelas laptop harus ada di contextRef');

    // Penolakan pesan kosong
    assert.throws(() => cm.appendUserMessage('   '), /tidak boleh kosong/, 'Harus menolak string kosong');
  });

  // -------------------------------------------------------------------------
  // Test 3: appendAssistantMessage
  // -------------------------------------------------------------------------
  await testCase('Append Assistant Turn - Menyimpan respons asisten dengan metadata', () => {
    const cm = new ConversationManager();
    const turn = cm.appendAssistantMessage('Terdeteksi 1 laptop di tengah.', {
      provider: 'mock-ai-assistant',
      latencyMs: 45
    });

    assert.strictEqual(turn.role, 'assistant', 'Role harus assistant');
    assert.strictEqual(turn.content, 'Terdeteksi 1 laptop di tengah.', 'Konten asisten harus sesuai');
    assert.strictEqual(turn.provider, 'mock-ai-assistant', 'Provider harus tersimpan');
    assert.strictEqual(turn.latencyMs, 45, 'Latency harus tersimpan');

    // Penolakan pesan kosong
    assert.throws(() => cm.appendAssistantMessage(''), /tidak boleh kosong/, 'Harus menolak string kosong');
  });

  // -------------------------------------------------------------------------
  // Test 4: History Ordering
  // -------------------------------------------------------------------------
  await testCase('History Ordering - Menjaga urutan kronologis pesan', () => {
    const cm = new ConversationManager();
    cm.appendUserMessage('Pesan 1');
    cm.appendAssistantMessage('Jawaban 1');
    cm.appendUserMessage('Pesan 2');
    cm.appendAssistantMessage('Jawaban 2');

    const turns = cm.getAllTurns();
    assert.strictEqual(turns.length, 4);
    assert.strictEqual(turns[0].content, 'Pesan 1');
    assert.strictEqual(turns[1].content, 'Jawaban 1');
    assert.strictEqual(turns[2].content, 'Pesan 2');
    assert.strictEqual(turns[3].content, 'Jawaban 2');
  });

  // -------------------------------------------------------------------------
  // Test 5: Max 10 Turn Cap
  // -------------------------------------------------------------------------
  await testCase('Bounded Capacity - Maksimum batas 10 turns (FIFO eviction)', () => {
    const cm = new ConversationManager({ maxTurns: 10 });
    for (let i = 1; i <= 14; i++) {
      cm.appendUserMessage(`Pesan ke-${i}`);
    }

    const turns = cm.getAllTurns();
    assert.strictEqual(turns.length, 10, 'Jumlah turn tidak boleh melampaui 10');
    assert.strictEqual(turns[0].content, 'Pesan ke-5', 'Pesan tertua (1..4) harus terbuang');
    assert.strictEqual(turns[9].content, 'Pesan ke-14', 'Pesan terbaru harus berada di akhir');
  });

  // -------------------------------------------------------------------------
  // Test 6: Sliding Window of Last 6 Turns
  // -------------------------------------------------------------------------
  await testCase('Sliding Window - getRecentTurns(6) mengambil 6 turn terkini', () => {
    const cm = new ConversationManager({ maxTurns: 10, defaultWindow: 6 });
    for (let i = 1; i <= 8; i++) {
      cm.appendUserMessage(`Msg ${i}`);
    }

    const recent = cm.getRecentTurns(6);
    assert.strictEqual(recent.length, 6, 'Recent turns harus berjumlah 6');
    assert.strictEqual(recent[0].content, 'Msg 3', 'Turn tertua dalam window 6 adalah Msg 3');
    assert.strictEqual(recent[5].content, 'Msg 8', 'Turn terbaru adalah Msg 8');
  });

  // -------------------------------------------------------------------------
  // Test 7: Multiple ask() Calls Preserve History
  // -------------------------------------------------------------------------
  await testCase('Assistant Integration - Pemanggilan ask() berulang mempertahankan riwayat percakapan', async () => {
    const cm = new ConversationManager();
    const assistant = new VisionAssistant({
      aiProvider: new MockAIProvider(),
      conversationManager: cm,
      contextFn: () => ({
        timestamp: Date.now(),
        summary: { total_objects: 2, focal_object: 'laptop' },
        detections: [
          { id: 1, class_name: 'laptop', relative_position: 'tengah', bbox: [100, 100, 400, 400] },
          { id: 2, class_name: 'cup', relative_position: 'kiri', bbox: [20, 150, 80, 220] }
        ]
      })
    });

    const res1 = await assistant.ask('Apa yang ada di depan kamera?');
    assert(res1.success, 'Turn 1 harus sukses');

    const res2 = await assistant.ask('Yang mana paling besar?');
    assert(res2.success, 'Turn 2 harus sukses');

    const turns = cm.getAllTurns();
    assert.strictEqual(turns.length, 4, 'Harus ada 4 turns (2 user, 2 assistant)');
    assert.strictEqual(turns[0].role, 'user');
    assert.strictEqual(turns[1].role, 'assistant');
    assert.strictEqual(turns[2].role, 'user');
    assert.strictEqual(turns[3].role, 'assistant');
    assert(res2.answer.toLowerCase().includes('laptop'), 'Jawaban kedua harus mengidentifikasi laptop sebagai yang terbesar');
  });

  // -------------------------------------------------------------------------
  // Test 8: Clear Resets Conversation
  // -------------------------------------------------------------------------
  await testCase('Reset State - assistant.clear() mengosongkan riwayat ConversationManager', async () => {
    const assistant = new VisionAssistant({
      aiProvider: new MockAIProvider(),
      contextFn: () => ({ detections: [] })
    });

    await assistant.ask('Halo AI');
    assert.strictEqual(assistant.conversationManager.getAllTurns().length, 2);

    assistant.clear();
    assert.strictEqual(assistant.conversationManager.getAllTurns().length, 0, 'Turns harus kosong setelah clear()');
    assert.strictEqual(assistant.state, AssistantState.IDLE);
    assert.strictEqual(assistant.lastResult, null);
  });

  // -------------------------------------------------------------------------
  // Test 9: Current Context Query Gets Fresh Context
  // -------------------------------------------------------------------------
  await testCase('Fresh Context - Pertanyaan "sekarang/saat ini" selalu mengevaluasi konteks langsung', async () => {
    let mockObjects = [
      { id: 1, class_name: 'laptop', relative_position: 'tengah', bbox: [100, 100, 300, 300] }
    ];

    const assistant = new VisionAssistant({
      aiProvider: new MockAIProvider(),
      contextFn: () => ({
        timestamp: Date.now(),
        summary: { total_objects: mockObjects.length, class_counts: { [mockObjects[0]?.class_name]: 1 } },
        detections: mockObjects
      })
    });

    // Turn 1 saat hanya ada laptop
    const res1 = await assistant.ask('Apa yang ada di depan kamera?');
    assert(res1.answer.includes('laptop'));

    // Ubah scene kamera (kamera sekarang melihat person)
    mockObjects = [
      { id: 2, class_name: 'person', relative_position: 'tengah', bbox: [150, 50, 450, 450] }
    ];

    // Turn 2 bertanya tentang kondisi sekarang
    const res2 = await assistant.ask('Apa yang ada sekarang saat ini?');
    assert(res2.answer.includes('person'), 'Kueri konteks baru harus mendeteksi person, bukan laptop');
    assert(!res2.answer.includes('laptop'), 'Tidak boleh tertahan di konteks lama');
  });

  // -------------------------------------------------------------------------
  // Test 10: Retrospective "tadi/sebelumnya" with Retained Context
  // -------------------------------------------------------------------------
  await testCase('Retrospective Grounding - "tadi/sebelumnya" merujuk konteks yang tersimpan', async () => {
    const assistant = new VisionAssistant({
      aiProvider: new MockAIProvider(),
      contextFn: () => ({
        timestamp: Date.now(),
        summary: { total_objects: 1 },
        detections: [{ id: 1, class_name: 'bottle', relative_position: 'kanan', bbox: [400, 100, 500, 350] }]
      })
    });

    // Turn 1: Buat konteks
    await assistant.ask('Berapa objek di depan kamera?');

    // Turn 2: Tanya balik tentang apa yang dibahas tadi
    const resRetro = await assistant.ask('Apa yang tadi kita bahas sebelumnya?');
    assert(resRetro.success);
    assert(resRetro.answer.includes('Sebelumnya kita membahas'), 'Harus merujuk ringkasan sesi');
  });

  // -------------------------------------------------------------------------
  // Test 11: Fallback when Referenced Context is Unavailable
  // -------------------------------------------------------------------------
  await testCase('Deterministic Fallback - Menolak mengarang saat belum ada konteks percakapan rujukan', async () => {
    const assistant = new VisionAssistant({
      aiProvider: new MockAIProvider(),
      contextFn: () => ({ detections: [] })
    });

    // Belum pernah ada turn apa pun, user langsung bertanya tentang "tadi"
    const res = await assistant.ask('Apa yang tadi dibahas?');
    assert(res.success);
    assert(
      res.answer.includes('Belum ada konteks percakapan atau objek sebelumnya yang tercatat'),
      `Fallback harus menyatakan belum ada konteks, dapat: ${res.answer}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 12: Superlative / Relative Size Follow-up
  // -------------------------------------------------------------------------
  await testCase('Multi-turn Follow-up - Resolusi objek terbesar dan posisinya', async () => {
    const assistant = new VisionAssistant({
      aiProvider: new MockAIProvider(),
      contextFn: () => ({
        timestamp: Date.now(),
        summary: { total_objects: 3, focal_object: 'laptop' },
        detections: [
          { id: 'l1', class_name: 'laptop', relative_position: 'tengah', bbox: [180, 140, 460, 360] }, // area = 280*220 = 61600
          { id: 'b1', class_name: 'bottle', relative_position: 'kanan', bbox: [480, 160, 550, 320] },  // area = 70*160 = 11200
          { id: 'c1', class_name: 'cup', relative_position: 'kiri', bbox: [60, 180, 140, 260] }        // area = 80*80 = 6400
        ]
      })
    });

    // Q1
    const r1 = await assistant.ask('Apa yang ada di depan kamera?');
    assert(r1.answer.includes('laptop') && r1.answer.includes('bottle') && r1.answer.includes('cup'));

    // Q2: Yang mana paling besar?
    const r2 = await assistant.ask('Yang mana paling besar?');
    assert(r2.answer.includes('laptop'), 'Laptop harus teridentifikasi sebagai objek terbesar');

    // Q3: Di mana posisinya?
    const r3 = await assistant.ask('Di mana posisinya?');
    assert(r3.answer.includes('tengah'), 'Posisi laptop harus dinyatakan di area tengah');
  });

  // -------------------------------------------------------------------------
  // Test 13: Diagnostics & Turn Counts
  // -------------------------------------------------------------------------
  await testCase('Diagnostics - getDiagnostics mencatat rincian sesi secara akurat', async () => {
    const cm = new ConversationManager();
    cm.appendUserMessage('Tanya A');
    cm.appendAssistantMessage('Jawab A');
    cm.appendUserMessage('Tanya B');

    const diag = cm.getDiagnostics();
    assert.strictEqual(diag.turnCount, 3);
    assert.strictEqual(diag.userTurns, 2);
    assert.strictEqual(diag.assistantTurns, 1);
    assert.strictEqual(diag.maxTurns, 10);
    assert(diag.sessionId && diag.sessionId.startsWith('sess_'));
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
