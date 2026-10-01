/**
 * DatasetManagerService.js - Service Pengelolaan Dataset Disk (V0.6)
 * Mengelola interaksi dengan filesystem dataset nyata pada disk:
 * - Browse semua dataset, search, filter berdasarkan kelas dan sumber
 * - Single select & multi select
 * - Soft delete (Recycle Bin) & Restore
 * - Permanent delete
 * - Import file & folder
 * - Statistik dataset komprehensif
 */

import { ENDPOINTS, apiUrl } from './apiConfig.js';
import { apiFetch } from './ApiClient.js';

export class DatasetManagerService {
  constructor() {
    this.currentView = 'active'; // 'active' | 'trash'
    this.searchQuery = '';
    this.selectedClass = 'all';
    this.selectedSource = 'all';
    this.selectedIds = new Set();
    this.items = [];
    this.stats = {
      totalImages: 0,
      totalSizeBytes: 0,
      formattedTotalSize: '0 MB',
      classesCount: 0,
      classCounts: {},
      sourceCounts: {},
      trashCount: 0
    };
  }

  async fetchStats(timeoutMs = 6000) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
      const res = await apiFetch(ENDPOINTS.MANAGER_STATS, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        this.stats = data;
        return this.stats;
      }
    } catch (e) {
      console.warn('[DatasetManagerService] Gagal memuat stats:', e);
      throw e;
    }
    return this.stats;
  }

  async fetchList(options = {}, timeoutMs = 6000) {
    const view = options.view || this.currentView;
    const cls = options.class || this.selectedClass;
    const src = options.source || this.selectedSource;
    const search = options.search !== undefined ? options.search : this.searchQuery;

    const params = new URLSearchParams();
    params.set('view', view);
    if (cls && cls !== 'all') params.set('class', cls);
    if (src && src !== 'all') params.set('source', src);
    if (search) params.set('search', search);

    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
      const res = await apiFetch(`${ENDPOINTS.MANAGER_LIST}?${params.toString()}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        this.items = data.items || [];
        this.currentView = view;
        return this.items;
      }
    } catch (e) {
      console.error('[DatasetManagerService] Gagal memuat daftar dataset:', e);
      throw e;
    }
    return [];
  }

  toggleSelect(id) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    return this.selectedIds;
  }

  selectAll() {
    this.items.forEach(it => this.selectedIds.add(it.id));
    return this.selectedIds;
  }

  clearSelection() {
    this.selectedIds.clear();
    return this.selectedIds;
  }

  getSelectedItems() {
    return this.items.filter(it => this.selectedIds.has(it.id));
  }

  async trashSelected() {
    const selected = this.getSelectedItems();
    if (selected.length === 0) return { count: 0 };

    const payload = {
      items: selected.map(it => ({
        filename: it.filename,
        className: it.className,
        source: it.source
      }))
    };

    const res = await apiFetch(ENDPOINTS.MANAGER_TRASH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Gagal memindahkan ke Recycle Bin');

    this.clearSelection();
    await this.fetchStats();
    await this.fetchList();
    return data;
  }

  async restoreSelected() {
    const selected = this.getSelectedItems();
    if (selected.length === 0) return { count: 0 };

    const payload = {
      items: selected.map(it => ({
        trashFilename: it.trashFilename || it.id,
        filename: it.filename,
        className: it.className,
        source: it.source
      }))
    };

    const res = await apiFetch(ENDPOINTS.MANAGER_RESTORE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Gagal merestore file');

    this.clearSelection();
    await this.fetchStats();
    await this.fetchList();
    return data;
  }

  async deletePermanentSelected() {
    const selected = this.getSelectedItems();
    if (selected.length === 0) return { count: 0 };

    const payload = {
      items: selected.map(it => ({
        id: it.id,
        trashFilename: it.trashFilename,
        filename: it.filename,
        className: it.className,
        source: it.source,
        fromTrash: this.currentView === 'trash'
      }))
    };

    const res = await apiFetch(ENDPOINTS.MANAGER_DELETE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Gagal menghapus permanen');

    this.clearSelection();
    await this.fetchStats();
    await this.fetchList();
    return data;
  }

  async importFileItems(files, targetClass = 'object') {
    const fileList = Array.from(files);
    const supportedExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const validFiles = fileList.filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      return supportedExts.includes(ext);
    });

    if (validFiles.length === 0) {
      throw new Error('Tidak ada file gambar valid (.jpg, .png, .webp).');
    }

    const payloadFiles = [];
    for (const f of validFiles) {
      const reader = new FileReader();
      const dataUrlPromise = new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(f);
      });
      const dataUrl = await dataUrlPromise;
      const cleanName = f.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      payloadFiles.push({
        filename: cleanName,
        className: targetClass,
        source: 'own_import',
        dataUrl
      });
    }

    const res = await apiFetch(ENDPOINTS.MANAGER_IMPORT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: payloadFiles })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Gagal mengimpor file.');

    await this.fetchStats();
    await this.fetchList();
    return data;
  }
}
