/**
 * ContextualPanelManager.js - VisionX V1.5 UI Helper
 * Manages Vision Mode contextual tool switcher & panels (Ask AI, Voice, Memory, Personal, Safety, Settings).
 * 
 * Rules:
 * - Exactly ONE contextual panel active at a time on mobile.
 * - Switching tool closes previous panel cleanly without scroll jump.
 * - Clicking active tool toggles closed.
 * - Fully accessible: WAI-ARIA tablist, keyboard arrow navigation, Escape to close, focus restore.
 */

export class ContextualPanelManager {
  /**
   * @param {Object} options
   * @param {HTMLElement} [options.container] - Root container for contextual tools
   * @param {Function} [options.onPanelChange] - Callback when active panel changes: (toolName, isOpen) => void
   */
  constructor(options = {}) {
    this.container = options.container || document.querySelector('.contextual-tools-nav-wrapper');
    this.nav = options.nav || document.querySelector('.contextual-tools-nav');
    this.indicator = options.indicator || document.getElementById('activeToolIndicator');
    this.onPanelChange = options.onPanelChange || null;

    this.activeTool = null; // 'ask' | 'voice' | 'memory' | 'personal' | 'safety' | 'settings' | null

    this.tools = [
      { id: 'ask', btnId: 'toolBtnAsk', panelId: 'askVisionPanel', name: 'Ask AI' },
      { id: 'voice', btnId: 'toolBtnVoice', panelId: 'voicePanel', name: 'Voice' },
      { id: 'memory', btnId: 'toolBtnMemory', panelId: 'objectMemoryPanel', name: 'Memory' },
      { id: 'personal', btnId: 'toolBtnPersonal', panelId: 'personalObjectsPanel', name: 'Personal' },
      { id: 'safety', btnId: 'toolBtnSafety', panelId: 'safetyAlertsPanel', name: 'Safety' },
      { id: 'settings', btnId: 'toolBtnSettings', panelId: 'settingsPanel', name: 'Settings' }
    ];

    this.buttons = new Map();
    this.panels = new Map();

    this.init();
  }

  init() {
    // Cache button & panel elements
    for (const tool of this.tools) {
      const btn = document.getElementById(tool.btnId) || document.querySelector(`[data-tool="${tool.id}"]`);
      const panel = document.getElementById(tool.panelId);

      if (btn) {
        this.buttons.set(tool.id, btn);
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', 'false');
        btn.setAttribute('aria-controls', tool.panelId);
        btn.setAttribute('tabindex', '0');

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.toggleTool(tool.id);
        });

        // WAI-ARIA Keyboard navigation across tabs
        btn.addEventListener('keydown', (e) => this.handleTabKeydown(e, tool.id));
      }

      if (panel) {
        this.panels.set(tool.id, panel);
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tool.btnId);
        panel.setAttribute('aria-hidden', 'true');
        panel.classList.remove('open');
      }
    }

    // Bind close buttons inside panels
    document.querySelectorAll('[data-close-tool]').forEach((closeBtn) => {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.closeAll();
      });
    });

    // Escape key listener to close active panel
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.activeTool) {
        const currentBtn = this.buttons.get(this.activeTool);
        this.closeAll();
        if (currentBtn && typeof currentBtn.focus === 'function') {
          currentBtn.focus();
        }
      }
    });

    // Wire #btnQuickAskVision to open Ask AI panel
    const btnQuickAsk = document.getElementById('btnQuickAskVision');
    if (btnQuickAsk) {
      btnQuickAsk.addEventListener('click', () => {
        this.openTool('ask');
        const askInput = document.getElementById('askVisionInput');
        if (askInput) {
          setTimeout(() => {
            askInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            askInput.focus();
          }, 100);
        }
      });
    }

    this.updateIndicator();
  }

  /**
   * Keyboard arrow navigation among contextual tool buttons (WAI-ARIA Tablist)
   */
  handleTabKeydown(e, currentToolId) {
    const toolIds = this.tools.map((t) => t.id);
    const currentIndex = toolIds.indexOf(currentToolId);
    let targetIndex = -1;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      targetIndex = (currentIndex + 1) % toolIds.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      targetIndex = (currentIndex - 1 + toolIds.length) % toolIds.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      targetIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      targetIndex = toolIds.length - 1;
    }

    if (targetIndex >= 0) {
      const targetId = toolIds[targetIndex];
      const targetBtn = this.buttons.get(targetId);
      if (targetBtn) {
        targetBtn.focus();
      }
    }
  }

  /**
   * Toggle a contextual tool (open if closed, close if currently active)
   * @param {string} toolId
   */
  toggleTool(toolId) {
    if (this.activeTool === toolId) {
      this.closeAll();
    } else {
      this.openTool(toolId);
    }
  }

  /**
   * Open a specific contextual tool panel
   * @param {string} toolId
   */
  openTool(toolId) {
    if (!this.panels.has(toolId)) return;

    // Close any currently active panel first (Strict 1-panel rule)
    for (const [id, panel] of this.panels.entries()) {
      if (id !== toolId) {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
      }
    }
    for (const [id, btn] of this.buttons.entries()) {
      if (id !== toolId) {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      }
    }

    // Activate the requested panel
    const panel = this.panels.get(toolId);
    const btn = this.buttons.get(toolId);

    if (panel) {
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
    }
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
    }

    this.activeTool = toolId;
    this.updateIndicator();

    if (typeof this.onPanelChange === 'function') {
      this.onPanelChange(toolId, true);
    }
  }

  /**
   * Close all contextual panels
   */
  closeAll() {
    const previousTool = this.activeTool;

    for (const panel of this.panels.values()) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
    for (const btn of this.buttons.values()) {
      btn.classList.remove('active');
      btn.setAttribute('aria-selected', 'false');
    }

    this.activeTool = null;
    this.updateIndicator();

    if (previousTool && typeof this.onPanelChange === 'function') {
      this.onPanelChange(previousTool, false);
    }
  }

  /**
   * Update active tool indicator text for screen readers & UI
   */
  updateIndicator() {
    if (!this.indicator) return;
    if (this.activeTool) {
      const toolObj = this.tools.find((t) => t.id === this.activeTool);
      const name = toolObj ? toolObj.name : this.activeTool;
      this.indicator.textContent = `Active Tool: ${name} (Tap to close)`;
      this.indicator.className = 'active-tool-indicator active';
    } else {
      this.indicator.textContent = 'None active (Tap to open)';
      this.indicator.className = 'active-tool-indicator';
    }
  }

  getActiveTool() {
    return this.activeTool;
  }

  isOpen(toolId) {
    return this.activeTool === toolId;
  }
}
