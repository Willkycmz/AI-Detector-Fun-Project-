/**
 * NavigationManager.js - VisionX V1.5 Navigation Architecture
 * Handles 5 primary modes synchronization:
 * Vision (detection) | Read (read_text) | Collect (collection) | Manager (manager) | Identity (identity)
 * Synchronizes:
 * - Mobile Bottom Navigation Bar (< 768px)
 * - Desktop/Tablet Top Segmented Navigation (>= 768px)
 * - VisionXWebApp.setMode() single source of truth
 */

export const PRIMARY_MODES = [
  'detection',
  'read_text',
  'collection',
  'manager',
  'identity'
];

export const MODE_ALIASES = {
  vision: 'detection',
  read: 'read_text',
  collect: 'collection',
  manager: 'manager',
  identity: 'identity'
};

export const DESKTOP_TAB_MAP = {
  detection: 'btnModeDetect',
  read_text: 'btnModeReadText',
  collection: 'btnModeCollect',
  manager: 'btnModeManager',
  identity: 'btnModeIdentity'
};

export class NavigationManager {
  /**
   * @param {Object} options
   * @param {string} [options.initialMode='detection']
   * @param {Function} [options.onModeChange] Callback when user triggers a mode change
   * @param {boolean} [options.enableKeyboard=true] Enable arrow key navigation
   */
  constructor(options = {}) {
    this.activeMode = this.normalizeMode(options.initialMode || 'detection') || 'detection';
    this.onModeChange = options.onModeChange || null;
    this.enableKeyboard = options.enableKeyboard !== false;
    
    this.mobileNavItems = [];
    this.desktopNavItems = [];
    this._listeners = [];

    this.init();
  }

  /**
   * Normalizes mode name or alias to canonical mode id.
   * @param {string} mode
   * @returns {string|null}
   */
  normalizeMode(mode) {
    if (!mode || typeof mode !== 'string') return null;
    const clean = mode.trim().toLowerCase();
    if (clean === 'home' || clean === 'landing') return 'home';
    if (PRIMARY_MODES.includes(clean)) return clean;
    if (MODE_ALIASES[clean]) return MODE_ALIASES[clean];
    return null;
  }

  /**
   * Check if a mode string is valid.
   * @param {string} mode
   * @returns {boolean}
   */
  isValidMode(mode) {
    return this.normalizeMode(mode) !== null;
  }

  /**
   * Get list of supported primary modes.
   * @returns {string[]}
   */
  getSupportedModes() {
    return [...PRIMARY_MODES];
  }

  /**
   * Initialize DOM queries and event listeners.
   */
  init() {
    if (typeof document === 'undefined') return;

    // 1. Mobile Bottom Navigation Items
    this.mobileNavItems = Array.from(document.querySelectorAll('.bottom-nav-item'));
    this.mobileNavItems.forEach((item) => {
      const clickHandler = (e) => {
        e.preventDefault();
        const mode = item.dataset.mode;
        if (mode) {
          this.setActiveMode(mode, { triggerCallback: true });
        }
      };
      item.addEventListener('click', clickHandler);
      this._listeners.push({ el: item, event: 'click', fn: clickHandler });
    });

    // 2. Desktop/Tablet Top Tabs
    this.desktopNavItems = Object.entries(DESKTOP_TAB_MAP).map(([mode, btnId]) => {
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.dataset.mode = mode;
        const clickHandler = (e) => {
          e.preventDefault();
          this.setActiveMode(mode, { triggerCallback: true });
        };
        btn.addEventListener('click', clickHandler);
        this._listeners.push({ el: btn, event: 'click', fn: clickHandler });
      }
      return btn;
    }).filter(Boolean);

    // 2b. Home Navigation Triggers (Brand Logo & Desktop Home Tab)
    const homeTriggers = [
      document.getElementById('btnNavHome'),
      document.getElementById('brandLogo')
    ].filter(Boolean);

    homeTriggers.forEach((btn) => {
      const clickHandler = (e) => {
        e.preventDefault();
        this.setActiveMode('home', { triggerCallback: true });
      };
      btn.addEventListener('click', clickHandler);
      this._listeners.push({ el: btn, event: 'click', fn: clickHandler });
    });

    // 3. Accessible Keyboard Navigation
    if (this.enableKeyboard) {
      this.attachKeyboardNav(this.mobileNavItems);
      this.attachKeyboardNav(this.desktopNavItems);
    }

    // 3b. Mobile "Lainnya" Bottom Sheet Toggle
    const btnMore = document.getElementById('btnMobileMore');
    const moreSheet = document.getElementById('moreBottomSheet');
    const btnCloseSheet = document.getElementById('btnCloseMoreSheet');
    const sheetBackdrop = document.getElementById('moreSheetBackdrop');

    const openSheet = (e) => {
      if (e) e.preventDefault();
      if (moreSheet) {
        moreSheet.classList.remove('hidden');
        moreSheet.setAttribute('aria-hidden', 'false');
      }
    };

    const closeSheet = (e) => {
      if (e) e.preventDefault();
      if (moreSheet) {
        moreSheet.classList.add('hidden');
        moreSheet.setAttribute('aria-hidden', 'true');
      }
    };

    if (btnMore) {
      btnMore.addEventListener('click', openSheet);
      this._listeners.push({ el: btnMore, event: 'click', fn: openSheet });
    }
    if (btnCloseSheet) {
      btnCloseSheet.addEventListener('click', closeSheet);
      this._listeners.push({ el: btnCloseSheet, event: 'click', fn: closeSheet });
    }
    if (sheetBackdrop) {
      sheetBackdrop.addEventListener('click', closeSheet);
      this._listeners.push({ el: sheetBackdrop, event: 'click', fn: closeSheet });
    }

    if (moreSheet) {
      const sheetItems = moreSheet.querySelectorAll('.sheet-menu-item');
      sheetItems.forEach((btn) => {
        btn.addEventListener('click', closeSheet);
        this._listeners.push({ el: btn, event: 'click', fn: closeSheet });
      });
    }

    // 4. Initial Sync of UI Elements
    this.syncUI(this.activeMode);
  }

  /**
   * Attaches roving focus arrow key navigation to a list of tab elements.
   * @param {HTMLElement[]} items
   */
  attachKeyboardNav(items) {
    if (!items || items.length === 0) return;

    items.forEach((item, index) => {
      const keyHandler = (e) => {
        let targetIndex = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          targetIndex = (index + 1) % items.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          targetIndex = (index - 1 + items.length) % items.length;
        } else if (e.key === 'Home') {
          e.preventDefault();
          targetIndex = 0;
        } else if (e.key === 'End') {
          e.preventDefault();
          targetIndex = items.length - 1;
        }

        if (targetIndex >= 0 && items[targetIndex]) {
          const targetEl = items[targetIndex];
          targetEl.focus();
          const targetMode = targetEl.dataset.mode;
          if (targetMode) {
            this.setActiveMode(targetMode, { triggerCallback: true });
          }
        }
      };

      item.addEventListener('keydown', keyHandler);
      this._listeners.push({ el: item, event: 'keydown', fn: keyHandler });
    });
  }

  /**
   * Sets the active navigation mode and synchronizes both desktop & mobile UI.
   * @param {string} rawMode
   * @param {Object} [options]
   * @param {boolean} [options.triggerCallback=true] Whether to trigger onModeChange
   * @param {boolean} [options.scrollReset=false] Whether to reset scroll position
   * @returns {boolean} True if mode changed successfully, false if invalid or duplicate
   */
  setActiveMode(rawMode, options = {}) {
    const mode = this.normalizeMode(rawMode);
    if (!mode) {
      console.warn(`[NavigationManager] Rejected invalid mode: "${rawMode}". Allowed:`, PRIMARY_MODES);
      return false;
    }

    const triggerCallback = options.triggerCallback !== false;
    const isRepeated = (mode === this.activeMode);

    // Update internal state
    this.activeMode = mode;

    // Synchronize UI states (classes, ARIA, tabindex)
    this.syncUI(mode);

    // Optional safe scroll reset
    if (options.scrollReset && typeof window !== 'undefined') {
      const stage = document.querySelector('.stage-card');
      if (stage && typeof stage.scrollIntoView === 'function') {
        stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    // Trigger callback only if changed and callback requested (no duplicate events)
    if (!isRepeated && triggerCallback && typeof this.onModeChange === 'function') {
      this.onModeChange(mode);
    }

    return true;
  }

  /**
   * Synchronizes classes and accessibility attributes on all nav elements.
   * @param {string} mode
   */
  syncUI(mode) {
    if (typeof document === 'undefined') return;

    // Sync Mobile Bottom Nav Items
    this.mobileNavItems.forEach((item) => {
      const itemMode = item.dataset.mode;
      const isActive = (itemMode === mode);
      if (isActive) {
        item.classList.add('active');
        item.setAttribute('aria-selected', 'true');
        item.setAttribute('aria-current', 'page');
        item.setAttribute('tabindex', '0');
      } else {
        item.classList.remove('active');
        item.setAttribute('aria-selected', 'false');
        item.removeAttribute('aria-current');
        item.setAttribute('tabindex', '-1');
      }
    });

    // Sync Desktop Top Tabs
    Object.entries(DESKTOP_TAB_MAP).forEach(([tabMode, btnId]) => {
      const btn = document.getElementById(btnId);
      if (btn) {
        const isActive = (tabMode === mode);
        if (isActive) {
          btn.classList.add('active');
          btn.setAttribute('aria-selected', 'true');
          btn.setAttribute('tabindex', '0');
        } else {
          btn.classList.remove('active');
          btn.setAttribute('aria-selected', 'false');
          btn.setAttribute('tabindex', '-1');
        }
      }
    });

    // Sync Desktop Home Tab if present
    const homeBtn = document.getElementById('btnNavHome');
    if (homeBtn) {
      const isHome = (mode === 'home');
      if (isHome) {
        homeBtn.classList.add('active');
        homeBtn.setAttribute('aria-selected', 'true');
        homeBtn.setAttribute('tabindex', '0');
      } else {
        homeBtn.classList.remove('active');
        homeBtn.setAttribute('aria-selected', 'false');
        homeBtn.setAttribute('tabindex', '-1');
      }
    }

    // Sync Mobile "Lainnya" More Tab
    const moreBtn = document.getElementById('btnMobileMore');
    if (moreBtn) {
      const isMoreActive = (mode === 'manager' || mode === 'identity');
      if (isMoreActive) {
        moreBtn.classList.add('active');
        moreBtn.setAttribute('aria-selected', 'true');
        moreBtn.setAttribute('aria-current', 'page');
      } else {
        moreBtn.classList.remove('active');
        moreBtn.setAttribute('aria-selected', 'false');
        moreBtn.removeAttribute('aria-current');
      }
    }
  }

  /**
   * Update visibility of developer-only navigation items.
   * Developer-only modes: collection, manager, identity.
   * @param {string} role 'developer' | 'user'
   */
  updateRoleVisibility(role) {
    if (typeof document === 'undefined') return;
    const isDev = (role === 'developer');

    // 1. Desktop tabs (Collection, Manager, Identity)
    ['btnModeCollect', 'btnModeManager', 'btnModeIdentity'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        if (isDev) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }
    });

    // 2. Mobile Bottom Nav Item (Collection)
    this.mobileNavItems.forEach((item) => {
      if (item.dataset.mode === 'collection') {
        if (isDev) {
          item.classList.remove('hidden');
        } else {
          item.classList.add('hidden');
        }
      }
    });

    // 3. Mobile "Lainnya" Button (Opens Manager & Identity drawer)
    const btnMobileMore = document.getElementById('btnMobileMore');
    if (btnMobileMore) {
      if (isDev) {
        btnMobileMore.classList.remove('hidden');
      } else {
        btnMobileMore.classList.add('hidden');
      }
    }
  }

  /**
   * Returns current canonical active mode.
   * @returns {string}
   */
  getActiveMode() {
    return this.activeMode;
  }

  /**
   * Removes all event listeners for clean teardown.
   */
  destroy() {
    this._listeners.forEach(({ el, event, fn }) => {
      if (el && typeof el.removeEventListener === 'function') {
        el.removeEventListener(event, fn);
      }
    });
    this._listeners = [];
  }
}
