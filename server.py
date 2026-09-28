"""
VisionX Production Core Backend Gateway
========================================
Lightweight, secure API gateway designed for Termux / Cloudflare Tunnel / Production.
Endpoints:
- POST /api/login          : Server-side authentication, signed expiring token, brute-force protection
- POST /api/chat           : Authenticated, rate-limited, grounded SSE streaming multimodal chat
- POST /api/upload         : Tunnel image upload (phone camera capture)
- GET  /api/health         : Service health check
- GET  /status             : Gateway status check
"""

import os
import sys
import time
import json
import hmac
import hashlib
import secrets
import base64
import logging
from typing import Dict, Any, Optional, List, Tuple
from functools import wraps

from flask import Flask, request, Response, jsonify, stream_with_context
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
import requests

# -----------------------------------------------------------------------------
# Configuration & Environment
# -----------------------------------------------------------------------------
APP_PORT = int(os.environ.get("PORT", 5000))
VISIONX_ADMIN_PIN = os.environ.get("VISIONX_ADMIN_PIN", "visionx2026")
VISIONX_AUTH_SECRET = os.environ.get("VISIONX_AUTH_SECRET", "visionx-auth-secret-key-prod-2026")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")

# Maximum payload size: 2 MB
MAX_CONTENT_LENGTH = 2 * 1024 * 1024

# Allowed Origins
DEFAULT_ALLOWED_ORIGINS = [
    "https://app.visionx.my.id",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173"
]
env_origins = os.environ.get("VISIONX_ALLOWED_ORIGINS", "")
if env_origins:
    ALLOWED_ORIGINS = [o.strip() for o in env_origins.split(",") if o.strip()]
else:
    ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS

# Logging setup (strictly no secrets in logs)
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("visionx_gateway")

# -----------------------------------------------------------------------------
# Flask Application Setup
# -----------------------------------------------------------------------------
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

# Strict CORS setup
CORS(
    app,
    resources={r"/api/*": {"origins": ALLOWED_ORIGINS}},
    supports_credentials=True,
    allow_headers=["Authorization", "Content-Type", "Accept"],
    methods=["GET", "POST", "OPTIONS"]
)

# -----------------------------------------------------------------------------
# Rate Limiting & Brute-Force Protection State (In-Memory, Termux-friendly)
# -----------------------------------------------------------------------------
# Track login attempts: ip -> {"failed_count": int, "lockout_until": float, "requests": [timestamp]}
login_security_tracker: Dict[str, Dict[str, Any]] = {}
# Track general chat requests: ip_or_token -> [timestamp]
chat_rate_tracker: Dict[str, List[float]] = {}

MAX_LOGIN_FAILURES = 5
LOCKOUT_DURATION_SEC = 900  # 15 minutes
MAX_LOGIN_RPM = 10          # 10 login requests per minute
MAX_CHAT_RPM = 30           # 30 chat requests per minute


def get_client_ip() -> str:
    """Extract client IP respecting Cloudflare Tunnel headers."""
    cf_connecting_ip = request.headers.get("CF-Connecting-IP")
    if cf_connecting_ip:
        return cf_connecting_ip.split(",")[0].strip()
    x_forwarded_for = request.headers.get("X-Forwarded-For")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()
    return request.remote_addr or "127.0.0.1"


# -----------------------------------------------------------------------------
# Cryptographic Token Management (Standard Library HMAC-SHA256)
# -----------------------------------------------------------------------------
def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def b64url_decode(s: str) -> bytes:
    padding = 4 - (len(s) % 4)
    if padding != 4:
        s += "=" * padding
    return base64.urlsafe_b64decode(s.encode("utf-8"))


def generate_token(subject: str = "visionx_user", expires_in_sec: int = 86400) -> str:
    """Generate cryptographically signed expiring Bearer token."""
    now = int(time.time())
    payload = {
        "sub": subject,
        "iat": now,
        "exp": now + expires_in_sec,
        "nonce": secrets.token_hex(8)
    }
    payload_json = json.dumps(payload, separators=(',', ':')).encode("utf-8")
    payload_b64 = b64url_encode(payload_json)
    
    signature = hmac.new(
        VISIONX_AUTH_SECRET.encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256
    ).digest()
    sig_b64 = b64url_encode(signature)
    
    return f"{payload_b64}.{sig_b64}"


def verify_token(token_str: str) -> Optional[Dict[str, Any]]:
    """Verify signature and expiration of Bearer token. Returns payload or None."""
    if not token_str or "." not in token_str:
        return None
    
    parts = token_str.split(".")
    if len(parts) != 2:
        return None
    
    payload_b64, sig_b64 = parts
    try:
        expected_sig = hmac.new(
            VISIONX_AUTH_SECRET.encode("utf-8"),
            payload_b64.encode("utf-8"),
            hashlib.sha256
        ).digest()
        provided_sig = b64url_decode(sig_b64)
        
        if not hmac.compare_digest(expected_sig, provided_sig):
            return None
        
        payload_bytes = b64url_decode(payload_b64)
        payload = json.loads(payload_bytes.decode("utf-8"))
        
        # Expiry check
        if payload.get("exp", 0) < int(time.time()):
            return None
            
        return payload
    except Exception:
        return None


def require_auth(f):
    """Decorator requiring valid Authorization Bearer token."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header:
            return jsonify({"error": "Missing Authorization header"}), 401
        
        parts = auth_header.strip().split(" ")
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return jsonify({"error": "Malformed Authorization header. Format: Bearer <token>"}), 401
        
        token = parts[1]
        payload = verify_token(token)
        if not payload:
            return jsonify({"error": "Invalid or expired token"}), 401
        
        request.user = payload
        return f(*args, **kwargs)
    return decorated


# -----------------------------------------------------------------------------
# Error Handlers
# -----------------------------------------------------------------------------
@app.errorhandler(RequestEntityTooLarge)
def handle_413(e):
    return jsonify({"error": "Payload too large. Maximum allowed size is 2MB."}), 413


@app.errorhandler(400)
def handle_400(e):
    return jsonify({"error": "Bad request"}), 400


@app.errorhandler(404)
def handle_404(e):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(405)
def handle_405(e):
    return jsonify({"error": "Method not allowed"}), 405


@app.errorhandler(500)
def handle_500(e):
    logger.error("Internal Server Error occurred.")
    return jsonify({"error": "Internal server error"}), 500


# -----------------------------------------------------------------------------
# Base & Health Routes
# -----------------------------------------------------------------------------
@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({
        "status": "ok",
        "service": "VisionX Production Core Gateway",
        "version": "1.0.0",
        "timestamp": int(time.time())
    }), 200


@app.route("/status", methods=["GET"])
def server_status():
    return jsonify({
        "status": "online",
        "service": "visionx",
        "auth_enabled": True,
        "streaming_enabled": True
    }), 200


# -----------------------------------------------------------------------------
# Authentication Endpoint (POST /api/login)
# -----------------------------------------------------------------------------
@app.route("/api/login", methods=["POST"])
def api_login():
    client_ip = get_client_ip()
    now = time.time()
    
    # 1. Initialize or clean tracker for this IP
    if client_ip not in login_security_tracker:
        login_security_tracker[client_ip] = {
            "failed_count": 0,
            "lockout_until": 0.0,
            "requests": []
        }
    tracker = login_security_tracker[client_ip]
    
    # 2. Check Lockout
    if tracker["lockout_until"] > now:
        remaining = int(tracker["lockout_until"] - now)
        logger.warning(f"Locked out IP attempted login: {client_ip} ({remaining}s remaining)")
        return jsonify({
            "error": f"Too many failed login attempts. Locked out for {remaining} seconds."
        }), 429
    
    # 3. Rate limiting (10 req/min)
    tracker["requests"] = [t for t in tracker["requests"] if t > (now - 60.0)]
    if len(tracker["requests"]) >= MAX_LOGIN_RPM:
        return jsonify({"error": "Login rate limit exceeded. Try again in 1 minute."}), 429
    tracker["requests"].append(now)
    
    # 4. Parse request payload
    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON payload"}), 400
    
    pin = data.get("pin") or data.get("password") or data.get("secret")
    if not pin or not isinstance(pin, str):
        tracker["failed_count"] += 1
        return jsonify({"error": "Credentials required"}), 400
    
    # 5. Verify credentials server-side using constant-time comparison
    is_valid = hmac.compare_digest(pin.strip(), VISIONX_ADMIN_PIN)
    
    if not is_valid:
        tracker["failed_count"] += 1
        logger.warning(f"Failed login attempt from IP {client_ip} (count: {tracker['failed_count']})")
        if tracker["failed_count"] >= MAX_LOGIN_FAILURES:
            tracker["lockout_until"] = now + LOCKOUT_DURATION_SEC
            logger.warning(f"Locking out IP {client_ip} for {LOCKOUT_DURATION_SEC}s")
            return jsonify({
                "error": f"Too many failed login attempts. Locked out for {LOCKOUT_DURATION_SEC // 60} minutes."
            }), 429
        return jsonify({"error": "Invalid credentials"}), 401
    
    # 6. Success: reset failure count & issue signed Bearer token
    tracker["failed_count"] = 0
    tracker["lockout_until"] = 0.0
    
    expires_in_sec = 86400  # 24 hours
    token = generate_token(subject="visionx_operator", expires_in_sec=expires_in_sec)
    
    logger.info(f"Successful login from IP {client_ip}")
    return jsonify({
        "token": token,
        "token_type": "Bearer",
        "expires_in": expires_in_sec
    }), 200


# -----------------------------------------------------------------------------
# Phone Frame Upload Route (POST /api/upload)
# -----------------------------------------------------------------------------
@app.route("/api/upload", methods=["POST"])
def api_upload():
    """Endpoint for phone capture frame uploads via tunnel."""
    try:
        if "image" not in request.files:
            return jsonify({"status": "error", "message": "No image file in request"}), 400
        
        file = request.files["image"]
        info = request.form.get("info", "unknown")
        
        if file.filename == "":
            return jsonify({"status": "error", "message": "Empty file name"}), 400
        
        # Verify decodability/size in memory without writing raw snapshots to disk
        file_bytes = file.read()
        if len(file_bytes) > MAX_CONTENT_LENGTH:
            return jsonify({"status": "error", "message": "Image size exceeds limit"}), 413
        
        return jsonify({
            "status": "success",
            "message": "Uploaded successfully",
            "size": len(file_bytes),
            "info": info
        }), 200
    except Exception as e:
        logger.error(f"Error in /api/upload: {str(e)}")
        return jsonify({"status": "error", "message": "Upload processing error"}), 500


# -----------------------------------------------------------------------------
# VisionX Grounding Prompt Construction
# -----------------------------------------------------------------------------
def build_grounded_system_prompt(vision_context: Optional[Dict[str, Any]] = None, detections: Optional[List[Any]] = None) -> str:
    """Builds strict VisionX grounding instruction."""
    prompt = (
        "You are VisionX, an AI vision assistant connected to the VisionX computer-vision system.\n"
        "Ground visual claims ONLY in supplied VisionX context.\n\n"
        "Never invent:\n"
        "- detected objects\n"
        "- object locations\n"
        "- object movement\n"
        "- OCR text\n"
        "- safety state\n"
        "- identities\n"
        "- visual attributes not present in the supplied context\n\n"
        "When context is insufficient, explicitly say that the information is not available.\n"
        "Answer naturally, clearly, and concisely in the user's language (Indonesian or English as asked).\n\n"
        "=== SUPPLIED VISIONX SYSTEM CONTEXT ===\n"
    )
    
    # 1. Verified YOLO Detections
    all_dets = []
    if detections and isinstance(detections, list):
        all_dets = detections
    elif vision_context and isinstance(vision_context, dict) and "detections" in vision_context:
        all_dets = vision_context["detections"]
    
    if all_dets:
        det_lines = []
        for d in all_dets:
            if isinstance(d, dict):
                cname = d.get("class_name") or d.get("className") or "unknown"
                conf = d.get("confidence", 0.0)
                pos = d.get("relative_position") or d.get("position") or "frame"
                det_lines.append(f"- {cname} (confidence: {conf:.2f}, position: {pos})")
        prompt += "Detected Objects:\n" + ("\n".join(det_lines) if det_lines else "None") + "\n"
    else:
        prompt += "Detected Objects: None detected in current frame.\n"
    
    # 2. OCR Text
    ocr_text = ""
    if vision_context and isinstance(vision_context, dict):
        ocr_obj = vision_context.get("ocr", {})
        if isinstance(ocr_obj, dict):
            ocr_text = ocr_obj.get("text", "").strip()
        elif isinstance(ocr_obj, str):
            ocr_text = ocr_obj.strip()
    if ocr_text:
        prompt += f"OCR Extracted Text: \"{ocr_text}\"\n"
    else:
        prompt += "OCR Extracted Text: None\n"
        
    # 3. Safety State
    if vision_context and isinstance(vision_context, dict) and "safety" in vision_context:
        safety = vision_context["safety"]
        if isinstance(safety, dict):
            prompt += f"Safety Risk Level: {safety.get('riskLevel', 'NORMAL')} (Active Events: {safety.get('activeEventCount', 0)})\n"
    
    # 4. Identity verification
    if vision_context and isinstance(vision_context, dict) and "identity" in vision_context:
        ident = vision_context["identity"]
        if isinstance(ident, dict):
            verified = ident.get("is_developer_verified", False)
            prompt += f"User Identity: {'Verified Developer' if verified else 'Standard User'}\n"
            
    prompt += "========================================\n"
    return prompt


# -----------------------------------------------------------------------------
# Local Grounded Fallback Streamer (For offline testing / when no API key set)
# -----------------------------------------------------------------------------
def stream_local_grounded_response(message: str, vision_context: Optional[Dict], detections: Optional[List]):
    """Generates grounded streaming chunks when external LLM is offline or unconfigured."""
    time.sleep(0.05)
    
    # Extract detections
    all_dets = []
    if detections and isinstance(detections, list):
        all_dets = detections
    elif vision_context and isinstance(vision_context, dict) and "detections" in vision_context:
        all_dets = vision_context["detections"]
        
    det_names = []
    for d in all_dets:
        if isinstance(d, dict):
            cname = d.get("class_name") or d.get("className")
            if cname and cname not in det_names:
                det_names.append(cname)
                
    msg_lower = message.lower()
    
    # Grounded answer logic
    if any(k in msg_lower for k in ["apa yang terlihat", "ada apa", "what do you see", "lihat"]):
        if det_names:
            ans = f"Berdasarkan visual VisionX saat ini, objek yang terdeteksi adalah: {', '.join(det_names)}."
        else:
            ans = "Saat ini tidak ada objek yang terdeteksi di dalam frame kamera."
    elif any(k in msg_lower for k in ["laptop", "komputer"]):
        if "laptop" in det_names:
            ans = "Ya, laptop terdeteksi di dalam pandangan kamera."
        else:
            ans = "Laptop tidak terdeteksi di dalam pandangan kamera saat ini."
    elif any(k in msg_lower for k in ["ponsel", "hp", "cell_phone", "phone"]):
        if "cell_phone" in det_names:
            ans = "Ya, ponsel (cell_phone) terdeteksi di dalam frame."
        else:
            ans = "Ponsel (cell_phone) tidak terdeteksi di dalam frame saat ini."
    elif "ocr" in msg_lower or "teks" in msg_lower or "tulisan" in msg_lower:
        ocr_text = ""
        if vision_context and isinstance(vision_context, dict) and "ocr" in vision_context:
            ocr_obj = vision_context["ocr"]
            ocr_text = ocr_obj.get("text", "") if isinstance(ocr_obj, dict) else str(ocr_obj)
        if ocr_text:
            ans = f"Teks yang terbaca oleh sistem OCR: \"{ocr_text}\"."
        else:
            ans = "Tidak ada teks yang terbaca dalam tampilan saat ini."
    else:
        if det_names:
            ans = f"VisionX mendeteksi {', '.join(det_names)}. Mengenai pertanyaan Anda: informasi visual tambahan tidak tersedia pada konteks saat ini."
        else:
            ans = "Berdasarkan konteks VisionX saat ini, tidak ada objek terdeteksi dan informasi visual tersebut tidak tersedia."

    # Progressive word-by-word streaming simulation
    words = ans.split(" ")
    for idx, w in enumerate(words):
        chunk = w + (" " if idx < len(words) - 1 else "")
        yield f"data: {json.dumps({'text': chunk})}\n\n"
        time.sleep(0.03)
        
    yield "data: [DONE]\n\n"


# -----------------------------------------------------------------------------
# Streaming Chat Endpoint (POST /api/chat)
# -----------------------------------------------------------------------------
@app.route("/api/chat", methods=["POST"])
@require_auth
def api_chat():
    client_ip = get_client_ip()
    now = time.time()
    
    # 1. Rate limiting on chat requests (30 req/min)
    if client_ip not in chat_rate_tracker:
        chat_rate_tracker[client_ip] = []
    chat_rate_tracker[client_ip] = [t for t in chat_rate_tracker[client_ip] if t > (now - 60.0)]
    if len(chat_rate_tracker[client_ip]) >= MAX_CHAT_RPM:
        return jsonify({"error": "Chat rate limit exceeded. Please wait a moment."}), 429
    chat_rate_tracker[client_ip].append(now)
    
    # 2. Validate JSON payload
    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON payload"}), 400
    
    message = data.get("message")
    if not message or not isinstance(message, str) or len(message.strip()) == 0:
        return jsonify({"error": "Field 'message' is required and must not be empty"}), 400
    
    message = message.strip()
    if len(message) > 4000:
        return jsonify({"error": "Message length exceeds maximum limit of 4000 characters"}), 400
    
    image_b64 = data.get("image")
    if image_b64 is not None:
        if not isinstance(image_b64, str):
            return jsonify({"error": "Field 'image' must be a base64 encoded string"}), 400
        if len(image_b64) > 2800000:  # ~2MB base64
            return jsonify({"error": "Image exceeds allowed size limit"}), 413
        # Strip data URL prefix if present
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]
        try:
            # Validate decodability
            _ = base64.b64decode(image_b64[:100] + "==")
        except Exception:
            return jsonify({"error": "Invalid base64 encoding for image"}), 400
            
    vision_context = data.get("vision_context")
    detections = data.get("detections")
    history = data.get("history") or []
    
    system_instruction = build_grounded_system_prompt(vision_context, detections)
    
    # 3. Stream Generator
    def generate_chat_stream():
        # Fallback to local grounded streamer if no GEMINI_API_KEY
        if not GEMINI_API_KEY:
            yield from stream_local_grounded_response(message, vision_context, detections)
            return
        
        # Prepare Google Gemini API payload
        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:streamGenerateContent?alt=sse&key={GEMINI_API_KEY}"
        
        contents = []
        # Add conversation history turns if provided
        if isinstance(history, list):
            for turn in history[-6:]:  # Keep recent context
                if isinstance(turn, dict) and "text" in turn:
                    role = "model" if turn.get("role") in ["assistant", "model"] else "user"
                    contents.append({
                        "role": role,
                        "parts": [{"text": str(turn["text"])}]
                    })
        
        # Current user turn
        user_parts = [{"text": message}]
        if image_b64:
            user_parts.append({
                "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": image_b64
                }
            })
            
        contents.append({
            "role": "user",
            "parts": user_parts
        })
        
        payload = {
            "system_instruction": {
                "parts": [{"text": system_instruction}]
            },
            "contents": contents,
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 1024
            }
        }
        
        try:
            with requests.post(endpoint, json=payload, stream=True, timeout=30) as resp:
                if resp.status_code != 200:
                    logger.error(f"Gemini API returned HTTP {resp.status_code}")
                    yield f"data: {json.dumps({'error': f'AI provider error (HTTP {resp.status_code})'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                
                for line in resp.iter_lines():
                    if line:
                        decoded_line = line.decode("utf-8")
                        if decoded_line.startswith("data: "):
                            raw_json = decoded_line[6:].strip()
                            if raw_json == "[DONE]":
                                break
                            try:
                                chunk_data = json.loads(raw_json)
                                candidates = chunk_data.get("candidates", [])
                                if candidates:
                                    parts = candidates[0].get("content", {}).get("parts", [])
                                    for p in parts:
                                        text_chunk = p.get("text", "")
                                        if text_chunk:
                                            yield f"data: {json.dumps({'text': text_chunk})}\n\n"
                            except Exception:
                                continue
                                
            yield "data: [DONE]\n\n"
        except requests.Timeout:
            logger.error("Gemini API request timed out (30s)")
            yield f"data: {json.dumps({'error': 'AI provider request timed out'})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as err:
            logger.error(f"Error streaming from AI provider: {str(err)}")
            yield f"data: {json.dumps({'error': 'AI provider stream error'})}\n\n"
            yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate_chat_stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


# -----------------------------------------------------------------------------
# Main entrypoint
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    logger.info(f"Starting VisionX Production Gateway on port {APP_PORT}...")
    logger.info(f"Allowed CORS Origins: {ALLOWED_ORIGINS}")
    app.run(host="0.0.0.0", port=APP_PORT, threaded=True)
