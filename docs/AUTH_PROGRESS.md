# VisionX Authentication & Authorization Progress Tracker

## Fase 1: Backend Auth & Role Developer (server.py)

| ID | Tugas | Status | File yang Diubah | Catatan |
|---|---|---|---|---|
| **B1** | Integrasi & Verifikasi JWT Supabase (PyJWT) | **DONE** | [`server.py`](file:///c:/Users/advan/Documents/VisionX/server.py), [`requirements.txt`](file:///c:/Users/advan/Documents/VisionX/requirements.txt) | Memasang dependensi `PyJWT>=2.8.0` dan `cryptography>=41.0.0`. Validasi signature HS256, expiration (`exp`), audience (`aud="authenticated"`), dan issuer (`iss`). |
| **B2** | Ekstraksi Role & Identitas User | **DONE** | [`server.py`](file:///c:/Users/advan/Documents/VisionX/server.py) | Ekstraksi role wajib dari claim `payload['app_metadata']['role']` (default 'user'). Payload `user_metadata` sengaja diabaikan untuk mencegah tampering. User ID disimpan dari claim `sub`. |
| **B3** | Decorator `@require_auth` & `@require_role` | **DONE** | [`server.py`](file:///c:/Users/advan/Documents/VisionX/server.py) | `@require_auth` mendukung Supabase JWT & Legacy PIN (`VISIONX_LEGACY_PIN=1`). `@require_role("developer")` melempar HTTP 403 Forbidden dengan pesan jelas jika role user bukan developer. |
| **B4** | Proteksi Endpoint Upload (`/api/upload` & `/api/dataset/save`) | **DONE** | [`server.py`](file:///c:/Users/advan/Documents/VisionX/server.py) | `/api/upload` dikunci `@require_auth`. `/api/dataset/save` dikunci `@require_role("developer")`. Penyimpanan fisik default diarahkan ke `/sdcard/AI-Detector` (prioritas Android) atau fallback lokal. |
| **B5** | Rate Limiting `/api/chat` | **DONE** | [`server.py`](file:///c:/Users/advan/Documents/VisionX/server.py) | Counter in-memory harian berbasis user ID (`sub`). Kuota role "user" dibatasi `VISIONX_USER_DAILY_CHAT_LIMIT` (default 30 pesan/hari -> HTTP 429). Role "developer" unlimited. |
| **B6** | Migrasi Endpoint Dataset, Manager, & Identity ke Flask | **DONE** | [`server.py`](file:///c:/Users/advan/Documents/VisionX/server.py) | Migrasi 13 endpoint (`/api/manager/*`, `/api/dataset/*`, `/api/identity/*`) ke Flask di bawah `@require_role("developer")`. Kontrak identik dengan dev middleware. Sanitasi ketat terhadap path traversal (`../`) & whitelist ekstensi gambar. |
| **B7** | Konfigurasi CORS Flask | **DONE** | [`server.py`](file:///c:/Users/advan/Documents/VisionX/server.py) | Mengizinkan header `Authorization`, `Content-Type`, `Accept`, `X-Requested-With` dari origin produksi `https://app.visionx.my.id` serta `http://localhost:5173` / `http://localhost:5174`. |
| **B8** | Verifikasi & Pengujian Bukti | **DONE** | [`tests/test_backend_auth_phase1.py`](file:///c:/Users/advan/Documents/VisionX/tests/test_backend_auth_phase1.py), [`scripts/verify_b8_curl.py`](file:///c:/Users/advan/Documents/VisionX/scripts/verify_b8_curl.py) | Berhasil lulus 9/9 pytest dan 6 skenario curl pengujian langsung (401 unauth, 403 role user, 200 role dev, 401 expired, 200 legacy PIN, 400 path traversal). |

### Bukti Pengujian Curl (Hasil Eksekusi Langsung)
1. **Request tanpa token**: HTTP 401 Unauthorized (`{"error":"Missing Authorization header"}`)
2. **Token role 'user' ke endpoint developer**: HTTP 403 Forbidden (`{"current_role":"user","error":"Forbidden: Developer role required"}`)
3. **Token role 'developer' ke endpoint developer**: HTTP 200 OK (`{"success":true,...}`)
4. **Token expired**: HTTP 401 Unauthorized (`{"error":"Token has expired"}`)
5. **Token PIN lama (legacy PIN=1)**: HTTP 200 OK (`{"role":"developer", ...}`)
6. **Percobaan path traversal (`../../etc/passwd.jpg`)**: HTTP 400 Bad Request (`{"error":"Directory traversal attempt detected in filename","success":false}`)
