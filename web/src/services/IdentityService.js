/**
 * IdentityService.js - Service Pengenalan Wajah & Identity Lab (V0.6)
 * Mengelola interaksi dengan VisionX Identity Lab:
 * - Registrasi profil pengembang ("VisionX Developer")
 * - Pengelolaan foto referensi wajah di datasets/faces/developer/
 * - Ekstraksi embeddings 128-d
 * - Pencocokan wajah realtime (Similarity Matching)
 * - Safety & Privacy: hanya mencocokkan profil terdaftar, lainnya diberi label "PERSON • UNKNOWN"
 */

import { ENDPOINTS } from './apiConfig.js';

export class IdentityService {
  constructor() {
    this.profileName = 'VisionX Developer';
    this.profileId = 'developer';
    this.referenceCount = 0;
    this.threshold = 0.60;
    this.isFaceLayerActive = false; // Toggle Face Recognition layer di Detection Mode
    this.references = [];
    this.lastMatchResult = null;
  }

  async getProfile() {
    try {
      const res = await fetch(ENDPOINTS.IDENTITY_PROFILE);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        this.profileName = data.profile_name || 'VisionX Developer';
        this.referenceCount = data.reference_count || 0;
        this.threshold = data.threshold || 0.60;
        return data;
      }
    } catch (e) {
      console.warn('[IdentityService] Gagal memuat profil identitas:', e);
    }
    return null;
  }

  async registerProfile(name) {
    if (!name || !name.trim()) throw new Error('Nama profil tidak boleh kosong.');
    const res = await fetch(ENDPOINTS.IDENTITY_REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Gagal mendaftarkan profil.');
    this.profileName = name.trim();
    return data;
  }

  async getReferences() {
    try {
      const res = await fetch(ENDPOINTS.IDENTITY_REFERENCES);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        this.references = data.references || [];
        this.referenceCount = this.references.length;
        return this.references;
      }
    } catch (e) {
      console.error('[IdentityService] Gagal memuat foto referensi:', e);
      throw e;
    }
    return [];
  }

  async addReference(dataUrl, filename = null) {
    if (!dataUrl) throw new Error('Citra wajah tidak boleh kosong.');
    const res = await fetch(ENDPOINTS.IDENTITY_ADD_REF, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, filename })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Gagal menambahkan foto referensi.');
    await this.getReferences();
    await this.getProfile();
    return data;
  }

  async deleteReference(filename) {
    if (!filename) throw new Error('Nama file referensi harus disertakan.');
    const res = await fetch(ENDPOINTS.IDENTITY_DEL_REF, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Gagal menghapus foto referensi.');
    await this.getReferences();
    await this.getProfile();
    return data;
  }

  async detectFaces(dataUrl) {
    if (!dataUrl) return null;
    try {
      const res = await fetch(ENDPOINTS.IDENTITY_DETECT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl })
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.success) {
        return data;
      }
    } catch (e) {
      // Non-blocking pada loop kamera
    }
    return null;
  }

  async matchFace(dataUrl, customThreshold = null) {
    if (!dataUrl) return null;
    const thresh = customThreshold !== null ? customThreshold : this.threshold;
    try {
      const res = await fetch(ENDPOINTS.IDENTITY_MATCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, threshold: thresh })
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.success) {
        this.lastMatchResult = data;
        return data;
      }
    } catch (e) {
      // Non-blocking pada loop kamera
    }
    return null;
  }
}
