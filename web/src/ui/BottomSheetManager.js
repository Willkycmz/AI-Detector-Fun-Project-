/**
 * BottomSheetManager.js - VisionX V1.5 UI Helper
 * Manages slide-up bottom sheets for mobile secondary controls and drawers.
 */

export class BottomSheetManager {
  constructor() {
    this.sheets = new Map();
    this.activeSheet = null;
    this.backdrop = null;
    this.init();
  }

  init() {
    // Look for backdrop or create one dynamically
    this.backdrop = document.getElementById('sheetBackdrop');
    if (!this.backdrop) {
      this.backdrop = document.createElement('div');
      this.backdrop.id = 'sheetBackdrop';
      this.backdrop.className = 'sheet-backdrop hidden';
      document.body.appendChild(this.backdrop);
    }

    this.backdrop.addEventListener('click', () => {
      this.closeActiveSheet();
    });

    // Close triggers
    document.querySelectorAll('[data-close-sheet]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.closeActiveSheet();
      });
    });

    // Open triggers
    document.querySelectorAll('[data-open-sheet]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = btn.dataset.openSheet;
        if (targetId) {
          this.openSheet(targetId);
        }
      });
    });
  }

  registerSheet(id, element) {
    if (element) {
      this.sheets.set(id, element);
    }
  }

  openSheet(id) {
    const sheet = this.sheets.get(id) || document.getElementById(id);
    if (!sheet) return;

    if (this.activeSheet && this.activeSheet !== sheet) {
      this.activeSheet.classList.remove('open');
    }

    this.activeSheet = sheet;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    if (this.backdrop) {
      this.backdrop.classList.remove('hidden');
    }
  }

  closeActiveSheet() {
    if (this.activeSheet) {
      this.activeSheet.classList.remove('open');
      this.activeSheet.setAttribute('aria-hidden', 'true');
      this.activeSheet = null;
    }
    if (this.backdrop) {
      this.backdrop.classList.add('hidden');
    }
  }

  toggleSheet(id) {
    const sheet = this.sheets.get(id) || document.getElementById(id);
    if (!sheet) return;

    if (sheet.classList.contains('open')) {
      this.closeActiveSheet();
    } else {
      this.openSheet(id);
    }
  }
}
