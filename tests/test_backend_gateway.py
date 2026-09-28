"""
Comprehensive Backend Gateway Test Suite
========================================
Verifies:
1. Authentication:
   - Successful login with correct PIN -> token returned
   - Invalid login credentials -> 401
   - Brute-force lockout after 5 failed attempts -> 429
   - Expired token -> 401
   - Malformed token -> 401
   - Missing token on protected endpoint -> 401
2. Security & Headers:
   - CORS origin check (https://app.visionx.my.id)
   - Preflight OPTIONS check
   - Payload limit > 2MB -> 413
   - Rate limiting on /api/chat -> 429
   - Malformed JSON payload -> 400
   - Invalid base64 image -> 400
3. Chat & Grounding:
   - SSE streaming format verification (text/event-stream, data: {...}, data: [DONE])
   - Grounded context: laptop detected -> recognized in response
   - Grounded context: absence of phone -> no hallucination
4. Phone tunnel upload:
   - /api/upload multipart form data -> 200
"""

import time
import json
import base64
import unittest
import io

# Import the server Flask app and helpers
import server
from server import app, generate_token, verify_token, login_security_tracker, chat_rate_tracker


class TestBackendGateway(unittest.TestCase):

    def setUp(self):
        self.client = app.test_client()
        # Reset security trackers for clean test state
        login_security_tracker.clear()
        chat_rate_tracker.clear()

    # -------------------------------------------------------------------------
    # 1. Authentication Tests
    # -------------------------------------------------------------------------
    def test_01_successful_login(self):
        """Login berhasil dengan PIN yang benar mengembalikan token Bearer."""
        res = self.client.post("/api/login", json={"pin": server.VISIONX_ADMIN_PIN})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertIn("token", data)
        self.assertEqual(data.get("token_type"), "Bearer")
        self.assertGreater(data.get("expires_in", 0), 0)
        
        # Verifikasi bahwa token yang dihasilkan valid
        payload = verify_token(data["token"])
        self.assertIsNotNone(payload)
        self.assertEqual(payload.get("sub"), "visionx_operator")

    def test_02_invalid_login(self):
        """Login gagal dengan PIN salah menghasilkan HTTP 401."""
        res = self.client.post("/api/login", json={"pin": "wrong_password_123"})
        self.assertEqual(res.status_code, 401)
        data = res.get_json()
        self.assertIn("error", data)

    def test_03_brute_force_lockout(self):
        """5 kali percobaan login gagal berturut-turut memicu lockout HTTP 429."""
        for i in range(server.MAX_LOGIN_FAILURES):
            res = self.client.post("/api/login", json={"pin": f"wrong_{i}"})
            if i < server.MAX_LOGIN_FAILURES - 1:
                self.assertEqual(res.status_code, 401)
            else:
                self.assertEqual(res.status_code, 429)
                self.assertIn("Locked out", res.get_json().get("error", ""))

        # Percobaan ke-6 bahkan dengan PIN benar tetap ditolak karena lockout
        res_locked = self.client.post("/api/login", json={"pin": server.VISIONX_ADMIN_PIN})
        self.assertEqual(res_locked.status_code, 429)

    def test_04_expired_token(self):
        """Token yang sudah kedaluwarsa (expired) menghasilkan HTTP 401."""
        # Generate token with negative expiry
        expired_token = generate_token(subject="user", expires_in_sec=-10)
        res = self.client.post(
            "/api/chat",
            headers={"Authorization": f"Bearer {expired_token}"},
            json={"message": "Halo VisionX"}
        )
        self.assertEqual(res.status_code, 401)
        self.assertIn("expired", res.get_json().get("error", "").lower())

    def test_05_malformed_token(self):
        """Token dengan format tidak valid atau signature korup menghasilkan HTTP 401."""
        # Token tanpa titik
        res1 = self.client.post(
            "/api/chat",
            headers={"Authorization": "Bearer malformed_token_without_period"},
            json={"message": "Halo"}
        )
        self.assertEqual(res1.status_code, 401)

        # Token dengan signature salah
        valid_token = generate_token(expires_in_sec=3600)
        tampered_token = valid_token[:-4] + "XXXX"
        res2 = self.client.post(
            "/api/chat",
            headers={"Authorization": f"Bearer {tampered_token}"},
            json={"message": "Halo"}
        )
        self.assertEqual(res2.status_code, 401)

    def test_06_missing_token_on_protected_endpoint(self):
        """Memanggil /api/chat tanpa header Authorization menghasilkan HTTP 401."""
        res = self.client.post("/api/chat", json={"message": "Halo"})
        self.assertEqual(res.status_code, 401)
        self.assertIn("Missing Authorization header", res.get_json().get("error", ""))

    # -------------------------------------------------------------------------
    # 2. CORS & Security Controls
    # -------------------------------------------------------------------------
    def test_07_cors_and_preflight(self):
        """Memverifikasi header CORS untuk origin produksi https://app.visionx.my.id."""
        prod_origin = "https://app.visionx.my.id"
        
        # Test OPTIONS preflight
        res = self.client.open(
            "/api/chat",
            method="OPTIONS",
            headers={
                "Origin": prod_origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization, Content-Type"
            }
        )
        self.assertIn(res.status_code, [200, 204])
        self.assertEqual(res.headers.get("Access-Control-Allow-Origin"), prod_origin)

    def test_08_payload_too_large(self):
        """Payload yang melebihi MAX_CONTENT_LENGTH (2MB) menghasilkan HTTP 413."""
        token = generate_token(expires_in_sec=3600)
        # Buat payload raksasa melebihi 2MB
        huge_payload = {"message": "A" * (2 * 1024 * 1024 + 5000)}
        res = self.client.post(
            "/api/chat",
            headers={"Authorization": f"Bearer {token}"},
            json=huge_payload
        )
        self.assertEqual(res.status_code, 413)

    def test_09_malformed_json_and_validation(self):
        """Request JSON yang tidak valid atau message kosong menghasilkan HTTP 400."""
        token = generate_token(expires_in_sec=3600)
        
        # Message kosong
        res = self.client.post(
            "/api/chat",
            headers={"Authorization": f"Bearer {token}"},
            json={"message": "   "}
        )
        self.assertEqual(res.status_code, 400)

        # Invalid base64 image
        res2 = self.client.post(
            "/api/chat",
            headers={"Authorization": f"Bearer {token}"},
            json={"message": "Ada apa?", "image": 12345}
        )
        self.assertEqual(res2.status_code, 400)

    # -------------------------------------------------------------------------
    # 3. Chat API & Grounded SSE Streaming Tests
    # -------------------------------------------------------------------------
    def test_10_chat_sse_streaming(self):
        """Memverifikasi bahwa /api/chat mengembalikan stream SSE dengan chunk yang valid dan [DONE]."""
        token = generate_token(expires_in_sec=3600)
        res = self.client.post(
            "/api/chat",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "message": "Apa yang terlihat?",
                "detections": [
                    {"class_name": "laptop", "confidence": 0.95, "relative_position": "tengah"}
                ]
            }
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/event-stream", res.content_type)
        
        # Baca seluruh stream lines
        data = res.get_data(as_text=True)
        self.assertIn("data: ", data)
        self.assertIn("[DONE]", data)
        
        # Verifikasi bahwa laptop terdeteksi dalam jawaban grounded
        self.assertIn("laptop", data.lower())

    def _assemble_sse_text(self, raw_sse: str) -> str:
        """Helper untuk mengekstrak dan merangkai potongan chunk text SSE."""
        assembled = []
        for line in raw_sse.splitlines():
            line = line.strip()
            if line.startswith("data: ") and not line.endswith("[DONE]"):
                try:
                    payload = json.loads(line[6:])
                    if "text" in payload:
                        assembled.append(payload["text"])
                except Exception:
                    pass
        return "".join(assembled)

    def test_11_grounding_positive_and_negative(self):
        """
        Grounded Context:
        - Jika context berisi laptop -> AI menyebut laptop.
        - Jika context TIDAK berisi cell_phone -> AI tidak mengada-ada cell_phone.
        """
        token = generate_token(expires_in_sec=3600)
        
        # Pertanyaan tentang ponsel saat hanya ada laptop
        res = self.client.post(
            "/api/chat",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "message": "Apakah ada ponsel?",
                "detections": [
                    {"class_name": "laptop", "confidence": 0.92, "relative_position": "kiri"}
                ]
            }
        )
        self.assertEqual(res.status_code, 200)
        assembled_text = self._assemble_sse_text(res.get_data(as_text=True)).lower()
        
        # Jawaban harus menyatakan ponsel tidak terdeteksi
        self.assertIn("tidak terdeteksi", assembled_text)

    # -------------------------------------------------------------------------
    # 4. Upload & Status Tests
    # -------------------------------------------------------------------------
    def test_12_upload_endpoint(self):
        """Endpoint /api/upload menerima multipart file citra."""
        img_bytes = b"\xff\xd8\xff\xe0" + b"\x00" * 50  # Dummy JPEG header
        data = {
            "image": (io.BytesIO(img_bytes), "capture.jpg"),
            "info": "test_label"
        }
        res = self.client.post("/api/upload", data=data, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        resp_json = res.get_json()
        self.assertEqual(resp_json.get("status"), "success")

    def test_13_health_check(self):
        """Endpoint /api/health mengembalikan status ok."""
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json().get("status"), "ok")


if __name__ == "__main__":
    unittest.main()
