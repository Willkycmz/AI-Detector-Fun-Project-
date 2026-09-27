/**
 * test_js_ui_helpers.mjs - Lightweight Unit Test Suite for VisionX V1.5 UI Helpers
 */

import assert from 'assert';

class MockElement {
  constructor(id = '', tagName = 'DIV') {
    this.id = id;
    this.tagName = tagName;
    this.classSet = new Set();
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.textContent = '';
    
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

  setAttributeNS(ns, k, v) {
    this.setAttribute(k, v);
  }

  removeAttribute(k) {
    this.attributes.delete(k);
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(fn);
  }

  dispatchEvent(event) {
    const fnList = this.listeners.get(event) || [];
    fnList.forEach(fn => fn({ target: this }));
  }

  click() {
    this.dispatchEvent('click');
  }
}

const elementsMap = new Map();
const navItemsList = [];

// Populate element mocks
const btnThemeToggle = new MockElement('btnThemeToggle', 'BUTTON');
const themeToggleIcon = new MockElement('themeToggleIcon', 'SPAN');
elementsMap.set('btnThemeToggle', btnThemeToggle);
elementsMap.set('themeToggleIcon', themeToggleIcon);

['btnModeDetect', 'btnModeCollect', 'btnModeManager', 'btnModeIdentity', 'btnModeReadText'].forEach(id => {
  elementsMap.set(id, new MockElement(id, 'BUTTON'));
});

const navDetect = new MockElement('navDetect', 'BUTTON');
navDetect.dataset.mode = 'detection';
navItemsList.push(navDetect);

const navOCR = new MockElement('navOCR', 'BUTTON');
navOCR.dataset.mode = 'read_text';
navItemsList.push(navOCR);

const backdrop = new MockElement('sheetBackdrop', 'DIV');
elementsMap.set('sheetBackdrop', backdrop);
const testSheet = new MockElement('testSheet', 'DIV');
elementsMap.set('testSheet', testSheet);

const mockStorage = new Map();

global.document = {
  getElementById: (id) => elementsMap.get(id) || null,
  querySelectorAll: (selector) => {
    if (selector === '.bottom-nav-item') return navItemsList;
    if (selector === '[data-close-sheet]') return [];
    if (selector === '[data-open-sheet]') return [];
    return [];
  },
  createElement: (tag) => new MockElement('', tag),
  documentElement: new MockElement('html', 'HTML'),
  body: new MockElement('body', 'BODY')
};

global.localStorage = {
  getItem: (k) => mockStorage.get(k) || null,
  setItem: (k, v) => mockStorage.set(k, String(v))
};

global.window = {
  matchMedia: () => ({ matches: false })
};

console.log('🧪 Testing UI Helper Modules...');

// Test ThemeManager
const { ThemeManager } = await import('../web/src/ui/ThemeManager.js');
const themeMgr = new ThemeManager();
assert.strictEqual(themeMgr.getTheme(), 'dark', 'Default theme should be dark');
themeMgr.toggleTheme();
assert.strictEqual(themeMgr.getTheme(), 'light', 'Theme should toggle to light');
assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'light');
console.log('  ✅ ThemeManager unit tests passed');

// Test NavigationManager
const { NavigationManager } = await import('../web/src/ui/NavigationManager.js');
let modeChangedTo = null;
const navMgr = new NavigationManager({
  onModeChange: (mode) => { modeChangedTo = mode; }
});
assert.strictEqual(navMgr.getActiveMode(), 'detection');

navMgr.setActiveMode('read_text');
assert.strictEqual(navMgr.getActiveMode(), 'read_text');
assert.strictEqual(modeChangedTo, 'read_text');
assert.strictEqual(document.getElementById('btnModeReadText').classList.contains('active'), true);
console.log('  ✅ NavigationManager unit tests passed');

// Test BottomSheetManager
const { BottomSheetManager } = await import('../web/src/ui/BottomSheetManager.js');
const sheetMgr = new BottomSheetManager();
sheetMgr.openSheet('testSheet');
assert.strictEqual(document.getElementById('testSheet').classList.contains('open'), true);
assert.strictEqual(document.getElementById('sheetBackdrop').classList.contains('hidden'), false);

sheetMgr.closeActiveSheet();
assert.strictEqual(document.getElementById('testSheet').classList.contains('open'), false);
assert.strictEqual(document.getElementById('sheetBackdrop').classList.contains('hidden'), true);
console.log('  ✅ BottomSheetManager unit tests passed');

console.log('\n🎉 ALL UI HELPER UNIT TESTS PASSED SUCCESSFULLY!');
