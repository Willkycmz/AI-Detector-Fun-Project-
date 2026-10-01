/**
 * VisionX — Centralized API Configuration
 * 
 * Single source of truth for all API endpoint URLs.
 * All services MUST import API_BASE_URL from this file
 * instead of hardcoding relative paths like '/api/...'
 * 
 * Environment variable override: VITE_API_BASE_URL
 */

const envBaseUrl = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
  ? import.meta.env.VITE_API_BASE_URL.replace(/\/$/, '')
  : null;

/**
 * Detect if we're running on a local Vite dev server.
 * When local, use empty string so fetch('/api/...') hits the Vite middleware
 * instead of going to the production URL across the network.
 */
const isLocalDev = typeof window !== 'undefined'
  && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

/**
 * Base URL for all API calls.
 * Priority:
 *   1. VITE_API_BASE_URL env variable (explicit override)
 *   2. '' (empty) when running on localhost (Vite dev middleware handles /api/*)
 *   3. Production backend at https://visionx.my.id (deployed builds)
 */
export const API_BASE_URL = envBaseUrl ?? (isLocalDev ? '' : 'https://visionx.my.id');

/**
 * Helper: build a full API URL from a relative path.
 * @param {string} path - e.g. '/api/upload', '/api/health'
 * @returns {string} Full URL e.g. 'https://visionx.my.id/api/upload'
 */
export function apiUrl(path) {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${cleanPath}`;
}

// ── Prebuilt endpoint constants ──────────────────────────────────────
export const ENDPOINTS = {
  // Upload / Tunnel
  UPLOAD:             apiUrl('/api/upload'),
  HEALTH:             apiUrl('/api/health'),

  // Dataset Capture & Management
  DATASET_LIST:       apiUrl('/api/dataset/list'),
  DATASET_SAVE:       apiUrl('/api/dataset/save'),
  DATASET_DELETE:     apiUrl('/api/dataset/delete'),
  DATASET_TRASH:      apiUrl('/api/dataset/trash'),
  DATASET_PERMANENT:  apiUrl('/api/dataset/permanent'),
  DATASET_RESTORE:    apiUrl('/api/dataset/restore'),
  DATASET_IMAGE:      apiUrl('/api/dataset/image'),

  // Dataset Manager
  MANAGER_STATS:      apiUrl('/api/manager/stats'),
  MANAGER_LIST:       apiUrl('/api/manager/list'),
  MANAGER_TRASH:      apiUrl('/api/manager/trash'),
  MANAGER_RESTORE:    apiUrl('/api/manager/restore'),
  MANAGER_DELETE:     apiUrl('/api/manager/delete-permanent'),
  MANAGER_IMPORT:     apiUrl('/api/manager/import'),

  // Identity
  IDENTITY_PROFILE:   apiUrl('/api/identity/profile'),
  IDENTITY_REGISTER:  apiUrl('/api/identity/register'),
  IDENTITY_REFERENCES:apiUrl('/api/identity/references'),
  IDENTITY_ADD_REF:   apiUrl('/api/identity/add-reference'),
  IDENTITY_DEL_REF:   apiUrl('/api/identity/delete-reference'),
  IDENTITY_DETECT:    apiUrl('/api/identity/detect'),
  IDENTITY_MATCH:     apiUrl('/api/identity/match'),

  // AI Chat
  CHAT:               apiUrl('/api/chat'),
  LOGIN:              apiUrl('/api/login'),
};
