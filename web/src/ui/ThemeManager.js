/**
 * ThemeManager.js - VisionX V1.5 UI Helper
 * Controls dark/light/system theme toggling and persistence.
 */

export class ThemeManager {
  constructor() {
    this.STORAGE_KEY = 'visionx_theme_preference';
    this.currentTheme = 'dark';
    this.init();
  }

  init() {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    if (saved) {
      this.currentTheme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      this.currentTheme = 'light';
    } else {
      this.currentTheme = 'dark';
    }

    this.applyTheme(this.currentTheme);

    const toggleBtn = document.getElementById('btnThemeToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.toggleTheme();
      });
    }
  }

  applyTheme(theme) {
    this.currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(this.STORAGE_KEY, theme);

    const iconEl = document.getElementById('themeToggleIcon');
    if (iconEl) {
      iconEl.textContent = theme === 'light' ? '☀️' : '🌙';
    }
  }

  toggleTheme() {
    const next = this.currentTheme === 'dark' ? 'light' : 'dark';
    this.applyTheme(next);
  }

  getTheme() {
    return this.currentTheme;
  }
}
