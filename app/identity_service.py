"""
VisionX Identity Lab Local Service (V0.6)
Menjalankan local HTTP server ringan (built-in http.server) untuk inferensi wajah berkecepatan tinggi:
- Memuat YuNet & SFace satu kali ke memori (latensi ~15ms per match)
- Endpoints:
  * GET  /api/identity/profile
  * GET  /api/identity/references
  * POST /api/identity/register
  * POST /api/identity/add-reference
  * POST /api/identity/delete-reference
  * POST /api/identity/match
- 100% lokal, tanpa upload ke cloud.
"""

import json
import base64
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
import cv2
import numpy as np
from app.identity import IdentityManager, DEFAULT_THRESHOLD

logger = logging.getLogger(__name__)
PORT = 5175


def decode_base64_image(base64_str: str) -> np.ndarray:
    """Mengonversi dataUrl base64 menjadi citra BGR OpenCV."""
    if "," in base64_str:
        base64_str = base64_str.split(",", 1)[1]
    img_bytes = base64.b64decode(base64_str)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Gagal men-decode citra dari base64.")
    return img


class IdentityRequestHandler(BaseHTTPRequestHandler):
    identity_manager = None

    def log_message(self, format, *args):
        # Meredam logging console standar untuk menjaga kebersihan terminal
        pass

    def _send_json(self, status_code: int, data: dict):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        mgr = self.identity_manager
        if self.path == "/api/identity/profile":
            refs = mgr.list_reference_images()
            data = {
                "success": True,
                "profile_id": mgr.profile_id,
                "profile_name": mgr.profile_name,
                "registered": True,
                "reference_count": len(refs),
                "threshold": mgr.threshold,
                "enrolled_count": len(mgr.metadata.get("enrolled_references", []))
            }
            self._send_json(200, data)
        elif self.path == "/api/identity/references":
            refs = mgr.list_reference_images()
            for r in refs:
                r["url"] = f"/datasets/faces/developer/{r['filename']}"
            self._send_json(200, {"success": True, "references": refs, "count": len(refs)})
        elif self.path == "/status" or self.path == "/health":
            self._send_json(200, {"status": "ok", "service": "VisionX Identity Service V0.6"})
        else:
            self._send_json(404, {"error": "Not Found"})

    def do_POST(self):
        mgr = self.identity_manager
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len).decode("utf-8") if content_len > 0 else "{}"
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            payload = {}

        if self.path == "/api/identity/register":
            name = payload.get("name", "VisionX Developer")
            try:
                res = mgr.register_profile(name)
                self._send_json(200, {"success": True, "profile": res})
            except Exception as e:
                self._send_json(400, {"success": False, "error": str(e)})

        elif self.path == "/api/identity/add-reference":
            data_url = payload.get("dataUrl")
            filename = payload.get("filename")
            if not data_url:
                self._send_json(400, {"success": False, "error": "Parameter dataUrl wajib diberikan."})
                return
            try:
                img = decode_base64_image(data_url)
                res = mgr.add_reference_image(img, filename)
                self._send_json(200, res)
            except Exception as e:
                self._send_json(400, {"success": False, "error": str(e)})

        elif self.path == "/api/identity/delete-reference":
            filename = payload.get("filename")
            if not filename:
                self._send_json(400, {"success": False, "error": "Parameter filename wajib diberikan."})
                return
            try:
                ok = mgr.delete_reference_image(filename)
                self._send_json(200, {"success": True, "deleted": ok, "filename": filename})
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})

        elif self.path == "/api/identity/detect":
            data_url = payload.get("dataUrl")
            if not data_url:
                self._send_json(400, {"success": False, "error": "Parameter dataUrl wajib diberikan."})
                return
            try:
                img = decode_base64_image(data_url)
                res = mgr.detect_faces(img)
                self._send_json(200, res)
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})

        elif self.path == "/api/identity/match":
            data_url = payload.get("dataUrl")
            thresh = payload.get("threshold", DEFAULT_THRESHOLD)
            if not data_url:
                self._send_json(400, {"success": False, "error": "Parameter dataUrl wajib diberikan."})
                return
            try:
                img = decode_base64_image(data_url)
                res = mgr.match_face(img, threshold=float(thresh))
                self._send_json(200, {"success": True, **res})
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})

        else:
            self._send_json(404, {"error": "Endpoint tidak ditemukan"})


def run_service(port: int = PORT):
    IdentityRequestHandler.identity_manager = IdentityManager()
    server = HTTPServer(("127.0.0.1", port), IdentityRequestHandler)
    print(f"[VisionX Identity Service] Berjalan di http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run_service()
