/**
 * AuthService.js - VisionX Supabase Authentication Service
 * 
 * Mengelola autentikasi berbasis Supabase Auth:
 * - signUp, signIn, resetPassword, signOut, getSession, onAuthStateChange
 * - getAccessToken(): mengembalikan JWT token aktif
 * - getRole(): mengambil role dari claim app_metadata.role (default "user")
 * - Dukungan fallback legacy PIN jika tersimpan di localStorage
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[AuthService] VITE_SUPABASE_URL atau VITE_SUPABASE_ANON_KEY belum dikonfigurasi di web/.env.local');
}

export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

class AuthService {
  constructor() {
    this.client = supabase;
    this.currentSession = null;
    this.currentUser = null;
    this._listeners = new Set();
    this.legacyTokenKey = 'visionx_auth_token';

    this.init();
  }

  async init() {
    if (!this.client) return;

    try {
      const { data: { session } } = await this.client.auth.getSession();
      this.currentSession = session;
      this.currentUser = session?.user || null;

      this.client.auth.onAuthStateChange((event, session) => {
        this.currentSession = session;
        this.currentUser = session?.user || null;
        this._notifyListeners(event, session);
      });
    } catch (err) {
      console.warn('[AuthService] Error saat inisialisasi session:', err);
    }
  }

  _notifyListeners(event, session) {
    this._listeners.forEach((listener) => {
      try {
        listener(event, session, this.getRole());
      } catch (e) {
        console.error('[AuthService] Listener error:', e);
      }
    });
  }

  onAuthStateChange(callback) {
    this._listeners.add(callback);
    return () => {
      this._listeners.delete(callback);
    };
  }

  /**
   * Mendaftar akun baru dengan email dan password.
   * @param {Object} credentials
   * @param {string} credentials.email
   * @param {string} credentials.password
   */
  async signUp({ email, password }) {
    if (!this.client) throw new Error('Supabase client belum terkonfigurasi.');
    const { data, error } = await this.client.auth.signUp({
      email: email.trim(),
      password: password
    });
    if (error) throw error;
    return data;
  }

  /**
   * Masuk menggunakan email dan password.
   * @param {Object} credentials
   * @param {string} credentials.email
   * @param {string} credentials.password
   */
  async signIn({ email, password }) {
    if (!this.client) throw new Error('Supabase client belum terkonfigurasi.');
    const { data, error } = await this.client.auth.signInWithPassword({
      email: email.trim(),
      password: password
    });
    if (error) throw error;
    this.currentSession = data.session;
    this.currentUser = data.user;
    return data;
  }

  /**
   * Mengirim instruksi reset password ke email.
   * @param {string} email
   */
  async resetPassword(email) {
    if (!this.client) throw new Error('Supabase client belum terkonfigurasi.');
    const { data, error } = await this.client.auth.resetPasswordForEmail(email.trim());
    if (error) throw error;
    return data;
  }

  /**
   * Keluar dari sesi login Supabase dan bersihkan token legacy.
   */
  async signOut() {
    try {
      if (this.client) {
        await this.client.auth.signOut();
      }
    } catch (err) {
      console.warn('[AuthService] Error signOut:', err);
    } finally {
      this.currentSession = null;
      this.currentUser = null;
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem(this.legacyTokenKey);
      }
      this._notifyListeners('SIGNED_OUT', null);
    }
  }

  /**
   * Mengambil sesi aktif.
   */
  async getSession() {
    if (!this.client) return null;
    const { data: { session } } = await this.client.auth.getSession();
    this.currentSession = session;
    this.currentUser = session?.user || null;
    return session;
  }

  /**
   * Mengembalikan Bearer JWT Token aktif:
   * 1. Dari Supabase session access_token
   * 2. Atau dari legacy token PIN di localStorage
   */
  getAccessToken() {
    if (this.currentSession?.access_token) {
      return this.currentSession.access_token;
    }
    // Fallback legacy PIN
    if (typeof window !== 'undefined' && window.localStorage) {
      const legacyToken = localStorage.getItem(this.legacyTokenKey);
      if (legacyToken) return legacyToken;
    }
    return null;
  }

  /**
   * Mengambil role DARI claim 'app_metadata.role' (default 'user').
   * JANGAN PERNAH mengambil role dari user_metadata.
   * HANYA untuk kenyamanan render UI.
   * @returns {'developer'|'user'}
   */
  getRole() {
    // Jika login menggunakan Supabase
    if (this.currentSession?.user) {
      const user = this.currentSession.user;
      const appMetadata = user.app_metadata || {};
      return appMetadata.role === 'developer' ? 'developer' : 'user';
    }

    // Jika menggunakan legacy PIN, otomatis 'developer'
    if (typeof window !== 'undefined' && window.localStorage) {
      const legacyToken = localStorage.getItem(this.legacyTokenKey);
      if (legacyToken) return 'developer';
    }

    return 'user';
  }

  /**
   * Memeriksa apakah pengguna memiliki role developer.
   */
  isDeveloper() {
    return this.getRole() === 'developer';
  }

  /**
   * Memeriksa apakah sesi telah terautentikasi (Supabase atau legacy token).
   */
  isAuthenticated() {
    return Boolean(this.getAccessToken());
  }

  /**
   * Mengambil objek user saat ini.
   */
  getUser() {
    return this.currentUser || (this.isAuthenticated() ? { email: 'developer@visionx.local' } : null);
  }

  /**
   * Mengambil user ID (sub) untuk namespace data atau chat.
   */
  getUserId() {
    if (this.currentUser?.id) {
      return this.currentUser.id;
    }
    if (this.isAuthenticated() && !this.currentUser) {
      return 'legacy_developer';
    }
    return 'guest';
  }
}

export const authService = new AuthService();
export default authService;
