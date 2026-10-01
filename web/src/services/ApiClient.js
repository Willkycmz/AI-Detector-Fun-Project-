/**
 * ApiClient.js - Centralized API Fetch Helper with Auth & Error Interceptors
 * 
 * - Otomatis menyertakan header 'Authorization: Bearer <access_token>'
 * - Handle HTTP 401: Buka modal login otomatis
 * - Handle HTTP 403: Tampilkan notifikasi "Akses ditolak: Fitur ini khusus Developer"
 */

import { authService } from './AuthService.js';

let _onAuthRequiredCallback = null;
let _onForbiddenCallback = null;

/**
 * Register global UI handlers for API status codes.
 * @param {Object} handlers
 * @param {Function} [handlers.onAuthRequired] Dipanggil saat 401 Unauthorized
 * @param {Function} [handlers.onForbidden] Dipanggil saat 403 Forbidden
 */
export function setApiEventHandlers({ onAuthRequired, onForbidden }) {
  if (typeof onAuthRequired === 'function') _onAuthRequiredCallback = onAuthRequired;
  if (typeof onForbidden === 'function') _onForbiddenCallback = onForbidden;
}

/**
 * Wrapper fetch terpusat untuk semua panggilan API ke backend VisionX.
 * @param {string|URL} url
 * @param {RequestInit} [options={}]
 * @returns {Promise<Response>}
 */
export async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});

  // 1. Otomatis sertakan token Bearer dari AuthService
  const token = authService.getAccessToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // Set default Content-Type jika bukan FormData dan method POST/PUT
  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers
    });

    // 2. Interceptor HTTP 401 Unauthorized
    if (response.status === 401) {
      console.warn('[ApiClient] 401 Unauthorized:', url);
      if (_onAuthRequiredCallback) {
        _onAuthRequiredCallback();
      }
    }

    // 3. Interceptor HTTP 403 Forbidden
    if (response.status === 403) {
      console.warn('[ApiClient] 403 Forbidden:', url);
      if (_onForbiddenCallback) {
        _onForbiddenCallback('Akses ditolak: Fitur ini khusus Developer.');
      }
    }

    return response;
  } catch (networkErr) {
    console.error('[ApiClient] Network/Fetch Error:', networkErr);
    throw networkErr;
  }
}

export default apiFetch;
