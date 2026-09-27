/**
 * test_js_safety_engine.mjs - Unit tests for VisionX V1.3 SafetyEngine
 */

import { SafetyEngine, SafetyEventType, SafetySeverity } from '../web/src/services/SafetyEngine.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('🛡️ Running VisionX V1.3 SafetyEngine Automated Test Suite');
  console.log('================================================================\n');

  // Test 1: Initialization & Diagnostics
  {
    console.log('• Testing: Initialization & Default State...');
    const engine = new SafetyEngine();
    assert(engine.config.enabled === true, 'Engine should be enabled by default');
    const diag = engine.getDiagnostics();
    assert(diag.totalEventsEmitted === 0, 'Initial emitted events should be 0');
    assert(diag.activeMonitoredTracks === 0, 'Initial monitored tracks should be 0');
    console.log('  ✅ PASSED');
  }

  // Test 2: Event Subscription & Unsubscribe
  {
    console.log('• Testing: Observer Subscription & Unsubscribe...');
    const engine = new SafetyEngine();
    let eventReceived = null;
    const unsub = engine.onSafetyEvent((evt) => {
      eventReceived = evt;
    });

    // Simulate OBJECT_LEFT
    engine.evaluate({
      memoryEvents: [{
        type: 'OBJECT_LEFT',
        trackId: 101,
        className: 'bottle',
        zone: 'kiri',
        isPersonal: false,
        durationMs: 4000
      }],
      timestamp: 1000
    });

    assert(eventReceived !== null, 'Observer should have received event');
    assert(eventReceived.type === SafetyEventType.OBJECT_LEFT, 'Event type should be OBJECT_LEFT');
    assert(eventReceived.severity === SafetySeverity.NORMAL, 'Generic object left should be NORMAL severity');
    assert(eventReceived.lastZone === 'kiri', 'Last zone should be kiri');

    // Test unsubscribe
    eventReceived = null;
    unsub();
    engine.evaluate({
      memoryEvents: [{
        type: 'OBJECT_LEFT',
        trackId: 102,
        className: 'cup',
        zone: 'kanan',
        isPersonal: false
      }],
      timestamp: 2000
    });
    assert(eventReceived === null, 'Unsubscribed observer should not receive events');
    console.log('  ✅ PASSED');
  }

  // Test 3: PERSONAL_OBJECT_LEFT Severity Mapping
  {
    console.log('• Testing: Personal Object Left Event & HIGH Severity...');
    const engine = new SafetyEngine();
    let eventReceived = null;
    engine.onSafetyEvent((evt) => {
      eventReceived = evt;
    });

    engine.evaluate({
      memoryEvents: [{
        type: 'OBJECT_LEFT',
        trackId: 5,
        className: 'laptop',
        personalObjectName: 'My Work Laptop',
        personalObjectId: 'po_laptop_1',
        isPersonal: true,
        zone: 'kanan',
        durationMs: 12000
      }],
      timestamp: 5000
    });

    assert(eventReceived !== null, 'Should emit event for personal object left');
    assert(eventReceived.type === SafetyEventType.PERSONAL_OBJECT_LEFT, 'Type should be PERSONAL_OBJECT_LEFT');
    assert(eventReceived.severity === SafetySeverity.HIGH, 'Severity for personal object left must be HIGH');
    assert(eventReceived.objectName === 'My Work Laptop', 'ObjectName should match personal name');
    assert(eventReceived.lastZone === 'kanan', 'LastZone should be kanan');
    console.log('  ✅ PASSED');
  }

  // Test 4: OBJECT_RETURNED Event
  {
    console.log('• Testing: Object Returned Event...');
    const engine = new SafetyEngine();
    let eventReceived = null;
    engine.onSafetyEvent((evt) => {
      eventReceived = evt;
    });

    engine.evaluate({
      memoryEvents: [{
        type: 'OBJECT_RETURNED',
        trackId: 5,
        className: 'laptop',
        personalObjectName: 'My Work Laptop',
        personalObjectId: 'po_laptop_1',
        isPersonal: true,
        zone: 'tengah',
        absentDurationMs: 6000
      }],
      timestamp: 10000
    });

    assert(eventReceived !== null, 'Should emit event for object returned');
    assert(eventReceived.type === SafetyEventType.OBJECT_RETURNED, 'Type should be OBJECT_RETURNED');
    assert(eventReceived.severity === SafetySeverity.HIGH, 'Returned personal object should be HIGH severity');
    assert(eventReceived.details.absentDurationMs === 6000, 'Absent duration should match');
    console.log('  ✅ PASSED');
  }

  // Test 5: PERSISTENT_OBJECT Stationary Rule
  {
    console.log('• Testing: Persistent Object Stationary Duration Rule...');
    const engine = new SafetyEngine({ persistenceThresholdMs: 10000 });
    let emittedEvents = [];
    engine.onSafetyEvent((evt) => {
      emittedEvents.push(evt);
    });

    // Frame at t=0
    engine.evaluate({
      activeTracks: [{ trackId: 22, className: 'backpack', spatialZone: 'tengah' }],
      timestamp: 1000
    });
    assert(emittedEvents.length === 0, 'Should not emit persistent object at t=0');

    // Frame at t=5s
    engine.evaluate({
      activeTracks: [{ trackId: 22, className: 'backpack', spatialZone: 'tengah' }],
      timestamp: 6000
    });
    assert(emittedEvents.length === 0, 'Should not emit persistent object at t=5s');

    // Frame at t=11s (stationary duration >= 10s)
    engine.evaluate({
      activeTracks: [{ trackId: 22, className: 'backpack', spatialZone: 'tengah' }],
      timestamp: 12000
    });
    assert(emittedEvents.length === 1, 'Should emit PERSISTENT_OBJECT event when threshold exceeded');
    assert(emittedEvents[0].type === SafetyEventType.PERSISTENT_OBJECT, 'Type should be PERSISTENT_OBJECT');
    assert(emittedEvents[0].trackId === 22, 'TrackId should be 22');

    // Frame at t=15s (already reported, should not spam again)
    engine.evaluate({
      activeTracks: [{ trackId: 22, className: 'backpack', spatialZone: 'tengah' }],
      timestamp: 16000
    });
    assert(emittedEvents.length === 1, 'Should not duplicate persistent event while still stationary');
    console.log('  ✅ PASSED');
  }

  // Test 6: DUPLICATE_TRACK_ANOMALY Rule
  {
    console.log('• Testing: Duplicate Track Anomaly for Personal Objects...');
    const engine = new SafetyEngine();
    let duplicateEvt = null;
    engine.onSafetyEvent((evt) => {
      if (evt.type === SafetyEventType.DUPLICATE_TRACK_ANOMALY) {
        duplicateEvt = evt;
      }
    });

    // Two different track IDs claiming the same personal object
    engine.evaluate({
      activeTracks: [
        { trackId: 1, isPersonal: true, personalObjectId: 'my_phone_id', personalObjectName: 'My iPhone', className: 'cell_phone', spatialZone: 'kiri' },
        { trackId: 2, isPersonal: true, personalObjectId: 'my_phone_id', personalObjectName: 'My iPhone', className: 'cell_phone', spatialZone: 'kanan' }
      ],
      timestamp: 20000
    });

    assert(duplicateEvt !== null, 'Should detect duplicate track anomaly');
    assert(duplicateEvt.severity === SafetySeverity.HIGH, 'Duplicate anomaly severity should be HIGH');
    assert(duplicateEvt.details.conflictingTrackIds.length === 2, 'Should record conflicting track IDs');
    console.log('  ✅ PASSED');
  }

  // Test 7: Event History Log & Reset
  {
    console.log('• Testing: Event History Log and Reset...');
    const engine = new SafetyEngine();
    engine.evaluate({
      memoryEvents: [{ type: 'OBJECT_LEFT', trackId: 1, className: 'cup', zone: 'kiri' }],
      timestamp: 1000
    });

    const history = engine.getEventHistory();
    assert(history.length === 1, 'History length should be 1');
    assert(history[0].type === SafetyEventType.OBJECT_LEFT, 'History record should match');

    engine.reset();
    assert(engine.getEventHistory().length === 0, 'History should be empty after reset');
    console.log('  ✅ PASSED');
  }

  console.log('\n================================================================');
  console.log('🏁 ALL SAFETY ENGINE TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('[SAFETY TEST FAILED]', err);
  process.exit(1);
});
