/**
 * ThemeManager.js - VisionX V1.5 UI Helper
 * Controls dark/light/system theme toggling and persistence.
 */

export class ThemeManager {
  constructor() {
    this.STORAGE_KEY = 'visionx_theme_preference';
    this.currentTheme = 'light';
    this.init();
  }

  init() {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    if (saved) {
      this.currentTheme = saved;
    } else {
      this.currentTheme = 'light';
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
    if (document.body) {
      document.body.classList.toggle('theme-dark', theme === 'dark');
      document.body.classList.toggle('theme-light', theme === 'light');
    }
    localStorage.setItem(this.STORAGE_KEY, theme);

    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', theme === 'dark' ? '#121212' : '#F7F7F5');
    }

    const iconEl = document.getElementById('themeToggleIcon');
    if (iconEl) {
      iconEl.textContent = theme === 'light' ? '🌙' : '☀️';
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
