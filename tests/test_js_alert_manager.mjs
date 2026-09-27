/**
 * test_js_alert_manager.mjs - Unit Test Suite for VisionX V1.3.1 Safety Alert Manager
 *
 * Menguji 18 skenario minimal:
 * 1. normal object left
 * 2. personal object left
 * 3. object returned
 * 4. persistent object
 * 5. duplicate anomaly
 * 6. severity mapping
 * 7. voice forwarding
 * 8. deduplication
 * 9. cooldown
 * 10. alert queue
 * 11. dismiss
 * 12. clear
 * 13. settings persistence
 * 14. disabled voice
 * 15. disabled safety alerts
 * 16. repeated event suppression
 * 17. different objects should not suppress each other
 * 18. same object after cooldown should alert again
 */

import { AlertManager, AlertState, DEFAULT_ALERT_CONFIG } from '../web/src/services/AlertManager.js';
import { SafetyEventType, SafetySeverity } from '../web/src/services/SafetyEngine.js';
import { SpeechPriority } from '../web/src/services/VoiceEngine.js';

// Mock VoiceEngine
class MockVoiceEngine {
  constructor() {
    this.spokenMessages = [];
  }

  speak(text, options = {}) {
    this.spokenMessages.push({ text, options, timestamp: Date.now() });
    return true;
  }

  reset() {
    this.spokenMessages = [];
  }
}

// Mock localStorage
const mockStorage = new Map();
global.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

let passedCount = 0;
let totalCount = 0;

function assert(condition, message) {
  totalCount++;
  if (condition) {
    passedCount++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('====================================================');
console.log('🧪 RUNNING VISIONX V1.3.1 ALERT MANAGER TEST SUITE');
console.log('====================================================');

// 1. Normal object left
{
  console.log('\n[Scenario 1] Normal object left');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice);

  const event = {
    type: SafetyEventType.OBJECT_LEFT,
    severity: SafetySeverity.NORMAL,
    objectName: 'mouse',
    className: 'mouse',
    trackId: 101,
    lastZone: 'kiri',
    timestamp: 1000
  };

  const alert = alertMgr.processEvent(event);
  assert(alert !== null, 'Normal object left produces an alert');
  assert(alert.severity === SafetySeverity.NORMAL, 'Severity is NORMAL');
  assert(mockVoice.spokenMessages.length === 0, 'Normal object left does not trigger TTS voice spam');
}

// 2. Personal object left
{
  console.log('\n[Scenario 2] Personal object left');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice);

  const event = {
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'My Laptop',
    className: 'laptop',
    trackId: 102,
    lastZone: 'kanan',
    timestamp: 1000,
    details: { personalObjectId: 'laptop_01' }
  };

  const alert = alertMgr.processEvent(event);
  assert(alert !== null, 'Personal object left produces an alert');
  assert(alert.severity === SafetySeverity.HIGH, 'Severity is HIGH');
  assert(alert.isPersonal === true, 'isPersonal is true');
  assert(mockVoice.spokenMessages.length === 1, 'Personal object left triggers VoiceEngine');
  assert(mockVoice.spokenMessages[0].text.includes('My Laptop') && mockVoice.spokenMessages[0].text.includes('kanan'), 'Speech contains object name and zone');
  assert(mockVoice.spokenMessages[0].options.priority === SpeechPriority.HIGH, 'Speech priority is HIGH');
}

// 3. Object returned
{
  console.log('\n[Scenario 3] Object returned');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice);

  // Normal object returned
  const normEvent = {
    type: SafetyEventType.OBJECT_RETURNED,
    severity: SafetySeverity.NORMAL,
    objectName: 'bottle',
    className: 'bottle',
    trackId: 103,
    lastZone: 'tengah',
    timestamp: 1000
  };
  const normAlert = alertMgr.processEvent(normEvent);
  assert(normAlert !== null, 'Normal returned alert created');
  assert(mockVoice.spokenMessages.length === 0, 'Normal object returned does not trigger voice spam');

  // Personal object returned
  const persEvent = {
    type: SafetyEventType.OBJECT_RETURNED,
    severity: SafetySeverity.HIGH,
    objectName: 'My Phone',
    className: 'cell_phone',
    trackId: 104,
    lastZone: 'tengah',
    timestamp: 1000,
    details: { personalObjectId: 'phone_01' }
  };
  const persAlert = alertMgr.processEvent(persEvent);
  assert(persAlert !== null, 'Personal returned alert created');
  assert(mockVoice.spokenMessages.length === 1, 'Personal object returned triggers voice');
  assert(mockVoice.spokenMessages[0].text.includes('My Phone lu kembali terlihat'), 'Speech announces personal object return in Indonesian');
}

// 4. Persistent object
{
  console.log('\n[Scenario 4] Persistent object alert');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice, { persistentAlertsEnabled: false });

  const event = {
    type: SafetyEventType.PERSISTENT_OBJECT,
    severity: SafetySeverity.NORMAL,
    objectName: 'cup',
    className: 'cup',
    trackId: 105,
    lastZone: 'kiri',
    timestamp: 1000
  };

  const alert1 = alertMgr.processEvent(event);
  assert(alert1 !== null, 'Persistent object alert created in UI');
  assert(mockVoice.spokenMessages.length === 0, 'Persistent alert voice disabled by default');

  // Enable persistent alerts
  alertMgr.updateConfig({ persistentAlertsEnabled: true });
  const event2 = {
    type: SafetyEventType.PERSISTENT_OBJECT,
    severity: SafetySeverity.NORMAL,
    objectName: 'backpack',
    className: 'backpack',
    trackId: 106,
    lastZone: 'kanan',
    timestamp: 20000
  };
  const alert2 = alertMgr.processEvent(event2);
  assert(alert2 !== null, 'Persistent object alert created');
  assert(mockVoice.spokenMessages.length === 1, 'Persistent alert speaks when enabled');
}

// 5. Duplicate anomaly
{
  console.log('\n[Scenario 5] Duplicate track anomaly');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice);

  const event = {
    type: SafetyEventType.DUPLICATE_TRACK_ANOMALY,
    severity: SafetySeverity.HIGH,
    objectName: 'My Laptop',
    className: 'laptop',
    trackId: 107,
    lastZone: 'tengah',
    timestamp: 1000,
    details: { personalObjectId: 'laptop_01', conflictingTrackIds: [107, 108] }
  };

  const alert = alertMgr.processEvent(event);
  assert(alert !== null, 'Duplicate anomaly alert created');
  assert(alert.severity === SafetySeverity.HIGH, 'Severity is HIGH');
  assert(mockVoice.spokenMessages.length === 1, 'Duplicate anomaly speaks warning');
  assert(mockVoice.spokenMessages[0].text.includes('anomali pelacakan'), 'Spoken text announces tracking anomaly');
}

// 6. Severity mapping
{
  console.log('\n[Scenario 6] Severity mapping');
  const alertMgr = new AlertManager(null);

  const normalEvt = { type: SafetyEventType.OBJECT_LEFT, severity: SafetySeverity.NORMAL, objectName: 'cup', timestamp: 1000 };
  const highEvt = { type: SafetyEventType.PERSONAL_OBJECT_LEFT, severity: SafetySeverity.HIGH, objectName: 'My Laptop', timestamp: 1000 };

  const a1 = alertMgr.processEvent(normalEvt);
  const a2 = alertMgr.processEvent(highEvt);

  assert(a1.severity === SafetySeverity.NORMAL, 'OBJECT_LEFT maps to NORMAL');
  assert(a2.severity === SafetySeverity.HIGH, 'PERSONAL_OBJECT_LEFT maps to HIGH');
}

// 7. Voice forwarding
{
  console.log('\n[Scenario 7] Voice forwarding');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice);

  alertMgr.processEvent({
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'Dompet',
    className: 'backpack',
    trackId: 110,
    lastZone: 'kiri',
    timestamp: 1000
  });

  assert(mockVoice.spokenMessages.length === 1, 'Voice forwarded to VoiceEngine.speak');
  assert(mockVoice.spokenMessages[0].options.priority === SpeechPriority.HIGH, 'Priority set correctly');
}

// 8. Deduplication
{
  console.log('\n[Scenario 8] Deduplication');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice, { personalLeftCooldownMs: 10000 });

  const evt = {
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'My Laptop',
    trackId: 111,
    lastZone: 'kanan',
    timestamp: 1000,
    details: { personalObjectId: 'laptop_01' }
  };

  const first = alertMgr.processEvent(evt);
  const duplicate = alertMgr.processEvent({ ...evt, timestamp: 1500 });

  assert(first !== null, 'First alert processed');
  assert(duplicate === null, 'Immediate duplicate event suppressed by deduplication');
  assert(mockVoice.spokenMessages.length === 1, 'Voice spoken only once');
}

// 9. Cooldown
{
  console.log('\n[Scenario 9] Cooldown duration');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice, { personalLeftCooldownMs: 10000 });

  const evt = {
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'My Laptop',
    trackId: 112,
    lastZone: 'kanan',
    timestamp: 1000,
    details: { personalObjectId: 'laptop_01' }
  };

  alertMgr.processEvent(evt);
  assert(alertMgr.processEvent({ ...evt, timestamp: 5000 }) === null, 'Suppressed at 5s (< 10s cooldown)');
  assert(alertMgr.processEvent({ ...evt, timestamp: 11001 }) !== null, 'Allowed at 11s (> 10s cooldown)');
}

// 10. Alert queue & history limit
{
  console.log('\n[Scenario 10] Alert queue');
  const alertMgr = new AlertManager(null, { maxAlertsHistory: 3, defaultCooldownMs: 0 });

  for (let i = 1; i <= 5; i++) {
    alertMgr.processEvent({
      type: SafetyEventType.OBJECT_LEFT,
      severity: SafetySeverity.NORMAL,
      objectName: `Obj_${i}`,
      trackId: i,
      timestamp: i * 1000
    });
  }

  const alerts = alertMgr.getAlerts();
  assert(alerts.length === 3, 'Alert queue respects maxAlertsHistory limit (3 items)');
  assert(alerts[0].objectName === 'Obj_5', 'Most recent alert is at index 0');
}

// 11. Dismiss alert
{
  console.log('\n[Scenario 11] Dismiss alert');
  const alertMgr = new AlertManager(null);

  const alert = alertMgr.processEvent({
    type: SafetyEventType.OBJECT_LEFT,
    severity: SafetySeverity.NORMAL,
    objectName: 'item_to_dismiss',
    trackId: 120,
    timestamp: 1000
  });

  assert(alertMgr.getAlerts().length === 1, '1 alert exists before dismiss');
  const dismissed = alertMgr.dismissAlert(alert.id);
  assert(dismissed === true, 'dismissAlert returns true');
  assert(alertMgr.getAlerts().length === 0, '0 alerts remain after dismiss');
}

// 12. Clear alerts
{
  console.log('\n[Scenario 12] Clear all alerts');
  const alertMgr = new AlertManager(null, { defaultCooldownMs: 0 });

  alertMgr.processEvent({ type: SafetyEventType.OBJECT_LEFT, objectName: 'item1', trackId: 130, timestamp: 1000 });
  alertMgr.processEvent({ type: SafetyEventType.OBJECT_LEFT, objectName: 'item2', trackId: 131, timestamp: 1000 });

  assert(alertMgr.getAlerts().length === 2, '2 alerts before clear');
  alertMgr.clearAlerts();
  assert(alertMgr.getAlerts().length === 0, '0 alerts after clear');
}

// 13. Settings persistence
{
  console.log('\n[Scenario 13] Settings persistence');
  mockStorage.clear();
  const alertMgr = new AlertManager(null);

  alertMgr.updateConfig({
    safetyAlertsEnabled: true,
    voiceSafetyAlertsEnabled: false,
    defaultCooldownMs: 15000
  });

  const stored = JSON.parse(mockStorage.get('visionx_safety_alert_config'));
  assert(stored.voiceSafetyAlertsEnabled === false, 'voiceSafetyAlertsEnabled stored in localStorage');
  assert(stored.defaultCooldownMs === 15000, 'defaultCooldownMs stored in localStorage');
}

// 14. Disabled voice
{
  console.log('\n[Scenario 14] Disabled voice safety alerts');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice, { voiceSafetyAlertsEnabled: false });

  const alert = alertMgr.processEvent({
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'My Laptop',
    trackId: 140,
    timestamp: 1000
  });

  assert(alert !== null, 'Alert is still created in UI list');
  assert(mockVoice.spokenMessages.length === 0, 'VoiceEngine is not called when voiceSafetyAlertsEnabled is false');
}

// 15. Disabled safety alerts
{
  console.log('\n[Scenario 15] Disabled safety alerts globally');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice, { safetyAlertsEnabled: false });

  const alert = alertMgr.processEvent({
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'My Laptop',
    trackId: 150,
    timestamp: 1000
  });

  assert(alert === null, 'No alert created when safetyAlertsEnabled is false');
  assert(alertMgr.getAlerts().length === 0, 'Alert list remains empty');
  assert(mockVoice.spokenMessages.length === 0, 'No voice when disabled');
}

// 16. Repeated event suppression
{
  console.log('\n[Scenario 16] Repeated event suppression in consecutive frames');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice);

  const evt = {
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'My Laptop',
    trackId: 160,
    timestamp: 1000
  };

  alertMgr.processEvent(evt);
  for (let frame = 1; frame <= 60; frame++) {
    const res = alertMgr.processEvent({ ...evt, timestamp: 1000 + frame * 33 }); // ~30fps for 2 seconds
    assert(res === null, `Frame ${frame} suppressed during ongoing absence`);
  }
  assert(mockVoice.spokenMessages.length === 1, 'Only exactly 1 speech event triggered across all frames');
}

// 17. Different objects should not suppress each other
{
  console.log('\n[Scenario 17] Different objects do not suppress each other');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice);

  const evt1 = {
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'Laptop',
    trackId: 171,
    timestamp: 1000,
    details: { personalObjectId: 'laptop_01' }
  };
  const evt2 = {
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'Mouse',
    trackId: 172,
    timestamp: 1050,
    details: { personalObjectId: 'mouse_01' }
  };

  const a1 = alertMgr.processEvent(evt1);
  const a2 = alertMgr.processEvent(evt2);

  assert(a1 !== null, 'Object 1 alert processed');
  assert(a2 !== null, 'Object 2 alert processed concurrently');
  assert(mockVoice.spokenMessages.length === 2, 'Both distinct objects trigger speech');
}

// 18. Same object after cooldown should alert again
{
  console.log('\n[Scenario 18] Same object after cooldown alerts again');
  const mockVoice = new MockVoiceEngine();
  const alertMgr = new AlertManager(mockVoice, { personalLeftCooldownMs: 10000 });

  const evt = {
    type: SafetyEventType.PERSONAL_OBJECT_LEFT,
    severity: SafetySeverity.HIGH,
    objectName: 'My Laptop',
    trackId: 180,
    timestamp: 1000,
    details: { personalObjectId: 'laptop_01' }
  };

  const a1 = alertMgr.processEvent(evt);
  assert(a1 !== null, 'First alert triggered at t=1000ms');

  const a2 = alertMgr.processEvent({ ...evt, timestamp: 15000 });
  assert(a2 !== null, 'Second alert triggered at t=15000ms after cooldown');
  assert(mockVoice.spokenMessages.length === 2, 'VoiceEngine received both alerts');
}

console.log('====================================================');
console.log(`🎉 ALL ${passedCount}/${totalCount} ALERT MANAGER TESTS PASSED SUCCESSFULLY!`);
console.log('====================================================\n');
