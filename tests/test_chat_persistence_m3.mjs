/**
 * test_chat_persistence_m3.mjs - VisionX Milestone 3 Test Suite
 * Tests for ChatStorageService (IndexedDB & Memory Fallback)
 */

import { ChatStorageService } from '../web/src/services/ChatStorageService.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAILED: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('💾 Running VisionX Milestone 3 — Chat Persistence (IndexedDB) Suite');
  console.log('================================================================');

  // Test 1: Fallback initialization when indexedDB is null in Node
  const storage = new ChatStorageService({ indexedDB: null });
  await storage.init();
  assert(storage.isReady === true, 'Storage initialized successfully');
  assert(storage._memoryFallback === true, 'Gracefully uses in-memory fallback when IndexedDB unavailable');

  // Test 2: Create sessions
  const s1 = await storage.createSession('session_1', 'Analisis Meja Kerja');
  assert(s1.id === 'session_1', 'Session 1 created with correct id');
  assert(s1.title === 'Analisis Meja Kerja', 'Session 1 title matches');

  const s2 = await storage.createSession('session_2', 'Deteksi Benda');
  assert(s2.id === 'session_2', 'Session 2 created');

  // Test 3: List sessions
  const sessions = await storage.getSessions();
  assert(sessions.length === 2, `Sessions list count matches 2 (got ${sessions.length})`);

  // Test 4: Save messages with small thumbnail (raw image not persisted)
  const fakeThumb = 'data:image/jpeg;base64,123456';
  const m1 = await storage.saveMessage({
    id: 'msg_1',
    sessionId: 'session_1',
    role: 'user',
    content: 'Apa yang ada di depan kamera?',
    snapshotThumbnail: fakeThumb
  });
  assert(m1.id === 'msg_1', 'User message 1 saved');
  assert(m1.snapshotThumbnail === fakeThumb, 'Thumbnail persisted in message');

  const m2 = await storage.saveMessage({
    id: 'msg_2',
    sessionId: 'session_1',
    role: 'assistant',
    content: 'Di depan kamera terdeteksi laptop, mouse, dan cup.',
    metadata: { provider: 'visionx-gateway', latencyMs: 250 }
  });
  assert(m2.id === 'msg_2', 'Assistant message 2 saved');

  // Test 5: Retrieve messages for session_1
  const msgs = await storage.getMessages('session_1');
  assert(msgs.length === 2, `Retrieved 2 messages for session_1 (got ${msgs.length})`);
  assert(msgs[0].role === 'user', 'Messages ordered chronologically (first user)');
  assert(msgs[1].role === 'assistant', 'Second message is assistant');

  // Test 6: Verify large raw image is bounded / sanitized
  const hugeImage = 'data:image/jpeg;base64,' + 'A'.repeat(200000);
  const m3 = await storage.saveMessage({
    id: 'msg_3',
    sessionId: 'session_2',
    role: 'user',
    content: 'Gambar besar',
    snapshotThumbnail: hugeImage
  });
  assert(m3.snapshotThumbnail.length <= 120000, 'Raw full image capped/bounded to prevent bloat');

  // Test 7: Update session title
  await storage.updateSession('session_1', { title: 'Analisis Meja Update' });
  const updatedSess = await storage.getSession('session_1');
  assert(updatedSess.title === 'Analisis Meja Update', 'Session title updated');

  // Test 8: Delete single session
  await storage.deleteSession('session_2');
  const afterDelete = await storage.getSessions();
  assert(afterDelete.length === 1 && afterDelete[0].id === 'session_1', 'Session 2 deleted properly');
  const msgsS2 = await storage.getMessages('session_2');
  assert(msgsS2.length === 0, 'Associated messages deleted when session deleted');

  // Test 9: Clear all data
  await storage.clearAllData();
  const emptySessions = await storage.getSessions();
  const emptyMsgs = await storage.getMessages('session_1');
  assert(emptySessions.length === 0, 'All sessions cleared');
  assert(emptyMsgs.length === 0, 'All messages cleared');

  console.log('================================================================');
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
