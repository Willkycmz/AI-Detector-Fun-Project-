/**
 * test_navigation_manager.mjs - Dedicated Unit Test Suite for VisionX V1.5 Navigation Architecture (Phase B)
 * Validates:
 * 1. default Vision mode
 * 2. switch all 5 modes
 * 3. mobile nav sync
 * 4. desktop nav sync
 * 5. state sync dengan setMode()
 * 6. active state
 * 7. invalid mode handling
 * 8. repeated navigation
 * 9. keyboard navigation state
 * 10. no duplicate navigation events
 */

import assert from 'assert';

class MockElement {
  constructor(id = '', tagName = 'BUTTON') {
    this.id = id;
    this.tagName = tagName;
    this.classSet = new Set();
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.textContent = '';
    this.isFocused = false;
    
    this.classList = {
      add: (...names) => names.forEach(n => this.classSet.add(n)),
      remove: (...names) => names.forEach(n => this.classSet.delete(n)),
      contains: (name) => this.classSet.has(name)
    };
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.get(k) || null;
  }

  removeAttribute(k) {
    this.attributes.delete(k);
  }

  hasAttribute(k) {
    return this.attributes.has(k);
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(fn);
  }

  removeEventListener(event, fn) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter(f => f !== fn));
  }

  dispatchEvent(eventObj) {
    const eventName = typeof eventObj === 'string' ? eventObj : eventObj.type;
    const fnList = this.listeners.get(eventName) || [];
    const eventPayload = typeof eventObj === 'string' ? { type: eventName, target: this, preventDefault: () => {} } : eventObj;
    if (!eventPayload.preventDefault) eventPayload.preventDefault = () => {};
    if (!eventPayload.target) eventPayload.target = this;
    fnList.forEach(fn => fn(eventPayload));
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this, preventDefault: () => {} });
  }

  focus() {
    this.isFocused = true;
  }
}

// Prepare Mock DOM Environment
const elementsMap = new Map();
const bottomNavItems = [];

const desktopButtonIds = {
  detection: 'btnModeDetect',
  read_text: 'btnModeReadText',
  collection: 'btnModeCollect',
  manager: 'btnModeManager',
  identity: 'btnModeIdentity'
};

Object.entries(desktopButtonIds).forEach(([mode, btnId]) => {
  const btn = new MockElement(btnId, 'BUTTON');
  btn.dataset.mode = mode;
  elementsMap.set(btnId, btn);
});

['detection', 'read_text', 'collection', 'manager', 'identity'].forEach(mode => {
  const navItem = new MockElement(`nav-${mode}`, 'BUTTON');
  navItem.dataset.mode = mode;
  bottomNavItems.push(navItem);
});

global.document = {
  getElementById: (id) => elementsMap.get(id) || null,
  querySelectorAll: (selector) => {
    if (selector === '.bottom-nav-item') return bottomNavItems;
    return [];
  },
  querySelector: () => null,
  createElement: (tag) => new MockElement('', tag),
  documentElement: new MockElement('html', 'HTML'),
  body: new MockElement('body', 'BODY')
};

global.window = {
  innerWidth: 1024,
  getComputedStyle: () => ({ display: 'block' })
};

console.log('🧪 Running VisionX V1.5 Navigation Architecture Tests (Phase B)...');

const { NavigationManager, PRIMARY_MODES } = await import('../web/src/ui/NavigationManager.js');

let modeChangeCalls = [];
const navManager = new NavigationManager({
  initialMode: 'detection',
  onModeChange: (mode) => {
    modeChangeCalls.push(mode);
  }
});

// 1. Default Vision mode
assert.strictEqual(navManager.getActiveMode(), 'detection', '1. Default mode should be detection (Vision)');
assert.strictEqual(elementsMap.get('btnModeDetect').classList.contains('active'), true, 'Desktop detect button should be active');
assert.strictEqual(bottomNavItems[0].classList.contains('active'), true, 'Mobile bottom nav vision should be active');
assert.strictEqual(bottomNavItems[0].getAttribute('aria-selected'), 'true');
assert.strictEqual(bottomNavItems[0].getAttribute('aria-current'), 'page');
console.log('  ✅ 1. Default Vision mode verified');

// 2. Switch all 5 modes
const testModes = ['read_text', 'collection', 'manager', 'identity', 'detection'];
testModes.forEach(mode => {
  const success = navManager.setActiveMode(mode);
  assert.strictEqual(success, true, `Should accept valid mode ${mode}`);
  assert.strictEqual(navManager.getActiveMode(), mode, `Active mode should be ${mode}`);
});
console.log('  ✅ 2. Switch all 5 modes verified');

// 3. Mobile nav sync
navManager.setActiveMode('read_text');
const readBottomItem = bottomNavItems.find(i => i.dataset.mode === 'read_text');
const visionBottomItem = bottomNavItems.find(i => i.dataset.mode === 'detection');
assert.strictEqual(readBottomItem.classList.contains('active'), true);
assert.strictEqual(readBottomItem.getAttribute('aria-selected'), 'true');
assert.strictEqual(readBottomItem.getAttribute('aria-current'), 'page');
assert.strictEqual(visionBottomItem.classList.contains('active'), false);
assert.strictEqual(visionBottomItem.getAttribute('aria-selected'), 'false');
assert.strictEqual(visionBottomItem.hasAttribute('aria-current'), false);
console.log('  ✅ 3. Mobile nav sync verified');

// 4. Desktop nav sync
const readDesktopBtn = elementsMap.get('btnModeReadText');
const detectDesktopBtn = elementsMap.get('btnModeDetect');
assert.strictEqual(readDesktopBtn.classList.contains('active'), true);
assert.strictEqual(readDesktopBtn.getAttribute('aria-selected'), 'true');
assert.strictEqual(readDesktopBtn.getAttribute('tabindex'), '0');
assert.strictEqual(detectDesktopBtn.classList.contains('active'), false);
assert.strictEqual(detectDesktopBtn.getAttribute('aria-selected'), 'false');
assert.strictEqual(detectDesktopBtn.getAttribute('tabindex'), '-1');
console.log('  ✅ 4. Desktop nav sync verified');

// 5. State sync dengan setMode() (using triggerCallback: false)
modeChangeCalls = [];
navManager.setActiveMode('collection', { triggerCallback: false });
assert.strictEqual(navManager.getActiveMode(), 'collection');
assert.strictEqual(modeChangeCalls.length, 0, 'No callback triggered when triggerCallback is false');
assert.strictEqual(elementsMap.get('btnModeCollect').classList.contains('active'), true);
console.log('  ✅ 5. State sync with setMode() verified');

// 6. Active state consistency
['manager', 'identity', 'detection'].forEach(m => {
  navManager.setActiveMode(m);
  assert.strictEqual(navManager.getActiveMode(), m);
  const activeDesktop = elementsMap.get(desktopButtonIds[m]);
  assert.strictEqual(activeDesktop.classList.contains('active'), true);
  const activeMobile = bottomNavItems.find(i => i.dataset.mode === m);
  assert.strictEqual(activeMobile.classList.contains('active'), true);
});
console.log('  ✅ 6. Active state consistency verified');

// 7. Invalid mode handling
modeChangeCalls = [];
const invalidResult1 = navManager.setActiveMode('invalid_mode');
assert.strictEqual(invalidResult1, false, 'Invalid mode should return false');
const invalidResult2 = navManager.setActiveMode('memory'); // Contextual tool, not primary mode
assert.strictEqual(invalidResult2, false, 'Memory is contextual tool, should be rejected as primary mode');
assert.strictEqual(navManager.getActiveMode(), 'detection', 'Active mode should remain detection');
assert.strictEqual(modeChangeCalls.length, 0, 'No callback triggered for invalid mode');
console.log('  ✅ 7. Invalid mode handling verified');

// 8. Repeated navigation
modeChangeCalls = [];
navManager.setActiveMode('detection');
assert.strictEqual(modeChangeCalls.length, 0, 'Navigating to already active mode must not fire callback');
console.log('  ✅ 8. Repeated navigation suppression verified');

// 9. Keyboard navigation state (ArrowRight, ArrowLeft, Home, End)
const firstMobileItem = bottomNavItems[0];
firstMobileItem.dispatchEvent({
  type: 'keydown',
  key: 'ArrowRight',
  preventDefault: () => {}
});
assert.strictEqual(bottomNavItems[1].isFocused, true, 'ArrowRight should focus next item');
assert.strictEqual(navManager.getActiveMode(), 'read_text', 'ArrowRight should activate next mode');

firstMobileItem.dispatchEvent({
  type: 'keydown',
  key: 'End',
  preventDefault: () => {}
});
assert.strictEqual(bottomNavItems[4].isFocused, true, 'End should focus last item');
assert.strictEqual(navManager.getActiveMode(), 'identity', 'End should activate identity mode');

firstMobileItem.dispatchEvent({
  type: 'keydown',
  key: 'Home',
  preventDefault: () => {}
});
assert.strictEqual(bottomNavItems[0].isFocused, true, 'Home should focus first item');
assert.strictEqual(navManager.getActiveMode(), 'detection', 'Home should activate detection mode');
console.log('  ✅ 9. Keyboard navigation state verified');

// 10. No duplicate navigation events
modeChangeCalls = [];
// Simulate clicking mobile bottom nav item for 'read_text'
const readItem = bottomNavItems.find(i => i.dataset.mode === 'read_text');
readItem.click();
assert.deepStrictEqual(modeChangeCalls, ['read_text'], 'Should fire onModeChange exactly once on click');

// Simulate clicking again
readItem.click();
assert.deepStrictEqual(modeChangeCalls, ['read_text'], 'Should not fire duplicate event on second click');
console.log('  ✅ 10. No duplicate navigation events verified');

console.log('\n🎉 ALL 10 NAVIGATION MANAGER TESTS PASSED SUCCESSFULLY!\n');
