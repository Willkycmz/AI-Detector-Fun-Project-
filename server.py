"""
VisionX Production Core Backend Gateway
========================================
Lightweight, secure API gateway designed for Termux / Cloudflare Tunnel / Production.
Phase 1: Supabase Authentication, Role-based Authorization ('developer' vs 'user'),
Sensitive Endpoint Protection, Rate Limiting, and Full Dataset/Manager/Identity API Migration.

Endpoints:
- POST /api/login                : Server-side PIN authentication, issues legacy signed token
- POST /api/chat                 : Authenticated, rate-limited (daily limit for 'user', unlimited for 'developer'), grounded SSE streaming chat
- POST /api/upload               : Authenticated image upload (phone camera capture -> physical storage)
- GET  /api/health               : Service health check
- GET  /status                   : Gateway status check
- GET  /api/manager/stats        : [Developer] Dataset summary stats
- GET  /api/manager/list         : [Developer] List active or trash dataset items
- POST /api/manager/trash        : [Developer] Soft delete dataset items to .trash
- POST /api/manager/restore      : [Developer] Restore dataset items from .trash
- POST /api/manager/delete-permanent : [Developer] Permanently delete dataset items
- POST /api/manager/import       : [Developer] Import images to dataset
- GET  /api/dataset/list         : [Developer] List dataset images by class
- POST /api/dataset/save         : [Developer] Save captured frame to dataset (physical storage)
- POST /api/dataset/delete       : [Developer] Delete dataset image
- GET  /api/identity/profile     : [Developer] Get developer face profile info
- GET  /api/identity/references  : [Developer] List registered face references
- POST /api/identity/register    : [Developer] Register developer profile name
- POST /api/identity/add-reference : [Developer] Add developer face reference image
- POST /api/identity/delete-reference : [Developer] Delete developer face reference image
- POST /api/identity/detect      : [Developer] Detect faces in base64 image
- POST /api/identity/match       : [Developer] Match face against registered developer profile
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
import re
import shutil
from pathlib import Path
from typing import Dict, Any, Optional, List, Tuple, Union
from functools import wraps

from flask import Flask, request, Response, jsonify, stream_with_context
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
import requests
import jwt
from jwt.exceptions import ExpiredSignatureError, InvalidTokenError, InvalidAudienceError

# Optional OpenCV & Identity Lab imports for graceful resilience
try:
    import cv2
    import numpy as np
    from app.identity import IdentityManager, DEFAULT_THRESHOLD
    HAVE_IDENTITY_MODULE = True
except Exception as _e:
    HAVE_IDENTITY_MODULE = False
    IdentityManager = None
    DEFAULT_THRESHOLD = 0.60
    cv2 = None
    np = None

# -----------------------------------------------------------------------------
# Configuration & Environment
# -----------------------------------------------------------------------------
APP_PORT = int(os.environ.get("PORT", 5000))
VISIONX_ADMIN_PIN = os.environ.get("VISIONX_ADMIN_PIN", "visionx2026")
VISIONX_AUTH_SECRET = os.environ.get("VISIONX_AUTH_SECRET", "visionx-auth-secret-key-prod-2026")
VISIONX_LEGACY_PIN = os.environ.get("VISIONX_LEGACY_PIN", "0").lower() in ("1", "true", "yes")

# Supabase Auth Configuration
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://wnwaniiuflsuemyambuy.supabase.co").rstrip("/")
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
SUPABASE_AUDIENCE = os.environ.get("SUPABASE_AUDIENCE", "authenticated")

# Rate Limiting Configuration
VISIONX_USER_DAILY_CHAT_LIMIT = int(os.environ.get("VISIONX_USER_DAILY_CHAT_LIMIT", 30))

# Gemini LLM Configuration
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")

# Maximum payload size: 10 MB (allows image dataset uploads and imports)
MAX_CONTENT_LENGTH = 10 * 1024 * 1024

# Allowed CORS Origins
DEFAULT_ALLOWED_ORIGINS = [
    "https://app.visionx.my.id",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
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
# Physical Storage Paths (Android /sdcard/AI-Detector priority)
# -----------------------------------------------------------------------------
DEFAULT_SDCARD_PATH = "/sdcard/AI-Detector"
env_storage_path = os.environ.get("VISIONX_STORAGE_PATH", "")

if env_storage_path:
    STORAGE_BASE_DIR = env_storage_path
elif os.path.exists(DEFAULT_SDCARD_PATH):
    STORAGE_BASE_DIR = DEFAULT_SDCARD_PATH
else:
    STORAGE_BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "datasets")

RAW_DATASET_ROOT = os.path.join(STORAGE_BASE_DIR, "raw")
TRASH_DATASET_ROOT = os.path.join(STORAGE_BASE_DIR, ".trash")
FACES_DATASET_ROOT = os.path.join(STORAGE_BASE_DIR, "faces", "developer")
UPLOADS_ROOT = os.path.join(STORAGE_BASE_DIR, "uploads")
TRASH_META_PATH = os.path.join(TRASH_DATASET_ROOT, ".trash_meta.json")

# Initialize physical storage directory structure
for _dir in [
    RAW_DATASET_ROOT,
    TRASH_DATASET_ROOT,
    FACES_DATASET_ROOT,
    UPLOADS_ROOT,
    os.path.join(RAW_DATASET_ROOT, "own"),
    os.path.join(RAW_DATASET_ROOT, "external")
]:
    try:
        os.makedirs(_dir, exist_ok=True)
    except Exception as _dir_err:
        logger.warning(f"Could not create directory {_dir}: {_dir_err}")

# -----------------------------------------------------------------------------
# Flask Application Setup & CORS (B7)
# -----------------------------------------------------------------------------
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

# B7: Strict CORS setup explicitly allowing Authorization, Content-Type, Accept
CORS(
    app,
    resources={r"/api/*": {"origins": ALLOWED_ORIGINS}},
    supports_credentials=True,
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
    methods=["GET", "POST", "OPTIONS", "DELETE", "PUT"]
)

# -----------------------------------------------------------------------------
# Rate Limiting & Brute-Force State (In-Memory, Termux-friendly)
# -----------------------------------------------------------------------------
# IP-based login tracker: ip -> {"failed_count": int, "lockout_until": float, "requests": [timestamp]}
login_security_tracker: Dict[str, Dict[str, Any]] = {}
# IP-based chat burst tracker: ip -> [timestamp]
chat_rate_tracker: Dict[str, List[float]] = {}
# B5: User ID ('sub') daily chat quota tracker: user_id -> {"date": "YYYY-MM-DD", "count": int}
user_daily_chat_tracker: Dict[str, Dict[str, Any]] = {}

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
# Input Sanitization & Path Traversal Prevention (B6)
# -----------------------------------------------------------------------------
ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def sanitize_filename(filename: str) -> str:
    """
    Sanitize file name strictly against path traversal ('../', absolute paths,
    path separators) and enforce image extension whitelist.
    """
    if not filename or not isinstance(filename, str):
        raise ValueError("Filename is required and must be a string")
    
    # Reject directory traversal indicators
    if ".." in filename or "/" in filename or "\\" in filename:
        raise ValueError("Directory traversal attempt detected in filename")
    
    clean_name = os.path.basename(filename).strip()
    ext = os.path.splitext(clean_name)[1].lower()
    if ext not in ALLOWED_IMAGE_EXTS:
        raise ValueError(f"File extension '{ext}' is not permitted. Whitelisted: {sorted(list(ALLOWED_IMAGE_EXTS))}")
    
    return clean_name


def sanitize_class_name(class_name: str) -> str:
    """Sanitize class or category folder name to prevent path traversal."""
    if not class_name or not isinstance(class_name, str):
        raise ValueError("Class name is required and must be a string")
    
    if ".." in class_name or "/" in class_name or "\\" in class_name:
        raise ValueError("Directory traversal attempt detected in class name")
    
    clean = class_name.strip().lower().replace(" ", "_")
    if not re.match(r'^[a-zA-Z0-9_\-]+$', clean):
        raise ValueError("Class name contains illegal characters. Only alphanumeric, _, - allowed.")
    
    return clean


def assert_safe_path(target_path: str, base_dir: str) -> str:
    """Verifies that target_path resolves strictly within base_dir."""
    abs_target = os.path.abspath(target_path)
    abs_base = os.path.abspath(base_dir)
    if not abs_target.startswith(abs_base):
        raise ValueError(f"Security violation: path traversal outside {abs_base} detected")
    return abs_target


def get_trash_meta() -> Dict[str, Any]:
    """Load metadata from .trash_meta.json safely."""
    if not os.path.exists(TRASH_META_PATH):
        return {"items": {}}
    try:
        with open(TRASH_META_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as err:
        logger.warning(f"Error loading trash metadata: {err}")
        return {"items": {}}


def save_trash_meta(meta: Dict[str, Any]) -> None:
    """Save metadata to .trash_meta.json safely."""
    try:
        os.makedirs(TRASH_DATASET_ROOT, exist_ok=True)
        with open(TRASH_META_PATH, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    except Exception as err:
        logger.error(f"Error saving trash metadata: {err}")


# -----------------------------------------------------------------------------
# Cryptographic Token Management & Supabase JWT Verification (B1, B2, B3)
# -----------------------------------------------------------------------------
def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def b64url_decode(s: str) -> bytes:
    padding = 4 - (len(s) % 4)
    if padding != 4:
        s += "=" * padding
    return base64.urlsafe_b64decode(s.encode("utf-8"))


def generate_token(subject: str = "visionx_operator", expires_in_sec: int = 86400) -> str:
    """Generate cryptographically signed expiring legacy Bearer token (HMAC-SHA256)."""
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


def verify_legacy_token(token_str: str) -> Optional[Dict[str, Any]]:
    """Verify legacy PIN token signature and expiration. Returns payload or None."""
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


def extract_auth_token() -> Tuple[Optional[str], Optional[str]]:
    """Extract Bearer token from the Authorization header."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header:
        return None, "Missing Authorization header"
    
    parts = auth_header.strip().split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None, "Malformed Authorization header. Format: Bearer <token>"
    
    return parts[1], None


def authenticate_token(token_str: str) -> Tuple[Optional[Dict[str, Any]], Optional[str], int]:
    """
    B1, B2, B3: Validates Bearer token as either Supabase JWT or Legacy PIN token.
    Returns: (user_dict, error_message, http_status_code)
    """
    if not token_str:
        return None, "Token missing", 401
    
    parts = token_str.split(".")
    
    # -------------------------------------------------------------------------
    # Case A: 3-part standard JWT (Supabase Auth token)
    # -------------------------------------------------------------------------
    if len(parts) == 3:
        if not SUPABASE_JWT_SECRET:
            logger.error("SUPABASE_JWT_SECRET is not configured on the server")
            return None, "Supabase authentication secret is not configured on backend", 500
        
        try:
            decode_kwargs: Dict[str, Any] = {
                "algorithms": ["HS256"],
                "options": {
                    "verify_exp": True,
                    "verify_aud": True
                }
            }
            if SUPABASE_AUDIENCE:
                decode_kwargs["audience"] = SUPABASE_AUDIENCE
            
            payload = jwt.decode(token_str, SUPABASE_JWT_SECRET, **decode_kwargs)
            
            # Optional: verify issuer if SUPABASE_URL is configured
            if SUPABASE_URL and "iss" in payload:
                expected_iss = f"{SUPABASE_URL.rstrip('/')}/auth/v1"
                if payload["iss"] != expected_iss:
                    logger.warning(f"JWT issuer mismatch: expected '{expected_iss}', got '{payload.get('iss')}'")
                    return None, "Invalid token issuer", 401
            
            # B2: Ekstraksi Role & Identitas User
            # WAJIB dari payload claim 'app_metadata.role' (default ke 'user' jika kosong).
            # JANGAN PERNAH mengambil role dari 'user_metadata'!
            app_metadata = payload.get("app_metadata") or {}
            role = "user"
            if isinstance(app_metadata, dict):
                role = app_metadata.get("role", "user")
            
            user_id = payload.get("sub", "unknown_user")
            
            user = {
                "id": user_id,
                "role": role,
                "email": payload.get("email"),
                "app_metadata": app_metadata,
                "auth_type": "supabase"
            }
            return user, None, 200
            
        except ExpiredSignatureError:
            logger.warning("Supabase JWT has expired")
            return None, "Token has expired", 401
        except InvalidAudienceError:
            logger.warning("Supabase JWT audience verification failed")
            return None, "Invalid token audience", 401
        except InvalidTokenError as err:
            logger.warning(f"Supabase JWT validation failed: {str(err)}")
            return None, f"Invalid token: {str(err)}", 401
        except Exception as err:
            logger.error(f"Unexpected error validating JWT: {str(err)}")
            return None, "Token verification failed", 401

    # -------------------------------------------------------------------------
    # Case B: 2-part token (VisionX Legacy PIN token)
    # -------------------------------------------------------------------------
    elif len(parts) == 2:
        if not VISIONX_LEGACY_PIN:
            logger.warning("Legacy PIN token rejected: VISIONX_LEGACY_PIN is disabled")
            return None, "Legacy PIN authentication is disabled", 401
        
        legacy_payload = verify_legacy_token(token_str)
        if not legacy_payload:
            return None, "Invalid or expired legacy token", 401
        
        # B3: Legacy PIN otomatis diberi role 'developer'
        user = {
            "id": legacy_payload.get("sub", "legacy_developer"),
            "role": "developer",
            "auth_type": "legacy_pin"
        }
        return user, None, 200

    else:
        return None, "Malformed token format", 401


def require_auth(f):
    """Decorator B3: Requires valid Supabase JWT or Legacy PIN token."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token, err = extract_auth_token()
        if err:
            return jsonify({"error": err}), 401
        
        user, auth_err, status_code = authenticate_token(token)
        if auth_err:
            return jsonify({"error": auth_err}), status_code
        
        request.user = user
        return f(*args, **kwargs)
    return decorated


def require_role(required_role: str):
    """
    Decorator B3: Requires authenticated user with a specific role (e.g. 'developer').
    Returns 403 Forbidden with a clear message if role does not match.
    """
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            # Verify authentication first if not already evaluated
            user = getattr(request, "user", None)
            if not user:
                token, err = extract_auth_token()
                if err:
                    return jsonify({"error": err}), 401
                
                auth_user, auth_err, status_code = authenticate_token(token)
                if auth_err:
                    return jsonify({"error": auth_err}), status_code
                
                request.user = auth_user
                user = auth_user
            
            user_role = user.get("role", "user")
            if user_role != required_role:
                logger.warning(
                    f"Access denied: User {user.get('id')} has role '{user_role}', "
                    f"required '{required_role}' for {request.path}"
                )
                return jsonify({
                    "error": f"Forbidden: {required_role.capitalize()} role required",
                    "current_role": user_role
                }), 403
            
            return f(*args, **kwargs)
        return decorated
    return decorator


# -----------------------------------------------------------------------------
# Identity Lab Lazy Loader (OpenCV / ONNX Model)
# -----------------------------------------------------------------------------
_identity_manager_instance: Optional[Any] = None


def get_identity_manager():
    """Lazily load IdentityManager instance pointing to FACES_DATASET_ROOT."""
    global _identity_manager_instance
    if not HAVE_IDENTITY_MODULE or IdentityManager is None:
        raise RuntimeError("OpenCV or Identity module is not available on this server.")
    
    if _identity_manager_instance is None:
        _identity_manager_instance = IdentityManager(faces_dir=Path(FACES_DATASET_ROOT))
    return _identity_manager_instance


def decode_base64_image(base64_str: str):
    """Decode dataUrl base64 string to BGR OpenCV image."""
    if not HAVE_IDENTITY_MODULE or cv2 is None or np is None:
        raise RuntimeError("OpenCV is not available to decode images.")
    if "," in base64_str:
        base64_str = base64_str.split(",", 1)[1]
    img_bytes = base64.b64decode(base64_str)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Failed to decode image from base64 string")
    return img


# -----------------------------------------------------------------------------
# Error Handlers
# -----------------------------------------------------------------------------
@app.errorhandler(RequestEntityTooLarge)
def handle_413(e):
    return jsonify({"error": f"Payload too large. Maximum allowed size is {MAX_CONTENT_LENGTH // (1024 * 1024)}MB."}), 413


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
        "version": "1.1.0",
        "auth": {
            "supabase_enabled": bool(SUPABASE_JWT_SECRET),
            "legacy_pin_enabled": VISIONX_LEGACY_PIN
        },
        "storage": STORAGE_BASE_DIR,
        "timestamp": int(time.time())
    }), 200


@app.route("/status", methods=["GET"])
def server_status():
    return jsonify({
        "status": "online",
        "service": "visionx",
        "auth_enabled": True,
        "legacy_pin_enabled": VISIONX_LEGACY_PIN,
        "streaming_enabled": True
    }), 200


# -----------------------------------------------------------------------------
# Legacy Authentication Endpoint (POST /api/login)
# -----------------------------------------------------------------------------
@app.route("/api/login", methods=["POST"])
def api_login():
    """Legacy PIN login endpoint. Issues HMAC-signed token with role 'developer'."""
    if not VISIONX_LEGACY_PIN:
        return jsonify({"error": "Legacy PIN authentication is disabled"}), 403
    
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
    
    logger.info(f"Successful legacy PIN login from IP {client_ip}")
    return jsonify({
        "token": token,
        "token_type": "Bearer",
        "expires_in": expires_in_sec,
        "role": "developer"
    }), 200


# -----------------------------------------------------------------------------
# Phone Frame Upload Route (POST /api/upload) (B4)
# -----------------------------------------------------------------------------
@app.route("/api/upload", methods=["POST"])
@require_auth
def api_upload():
    """
    B4: Endpoint for phone capture frame uploads via tunnel.
    Locked with @require_auth. Physical storage directed to UPLOADS_ROOT (/sdcard/AI-Detector/uploads).
    """
    try:
        if "image" not in request.files:
            return jsonify({"status": "error", "message": "No image file in request"}), 400
        
        file = request.files["image"]
        info = request.form.get("info", "unknown")
        
        if not file or not file.filename:
            return jsonify({"status": "error", "message": "Empty file name"}), 400
        
        try:
            safe_fname = sanitize_filename(file.filename)
        except ValueError as val_err:
            return jsonify({"status": "error", "message": str(val_err)}), 400
            
        file_bytes = file.read()
        if len(file_bytes) > MAX_CONTENT_LENGTH:
            return jsonify({"status": "error", "message": "Image size exceeds limit"}), 413
        
        # Save physically to UPLOADS_ROOT
        dest_filename = f"{int(time.time() * 1000)}_{safe_fname}"
        dest_path = os.path.join(UPLOADS_ROOT, dest_filename)
        assert_safe_path(dest_path, UPLOADS_ROOT)
        
        with open(dest_path, "wb") as f_out:
            f_out.write(file_bytes)
        
        return jsonify({
            "status": "success",
            "message": "Uploaded successfully",
            "size": len(file_bytes),
            "filename": dest_filename,
            "path": dest_path,
            "info": info
        }), 200
    except Exception as e:
        logger.error(f"Error in /api/upload: {str(e)}")
        return jsonify({"status": "error", "message": f"Upload processing error: {str(e)}"}), 500


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
# Local Grounded Fallback Streamer
# -----------------------------------------------------------------------------
def stream_local_grounded_response(message: str, vision_context: Optional[Dict], detections: Optional[List]):
    """Generates grounded streaming chunks when external LLM is offline or unconfigured."""
    time.sleep(0.05)
    
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

    words = ans.split(" ")
    for idx, w in enumerate(words):
        chunk = w + (" " if idx < len(words) - 1 else "")
        yield f"data: {json.dumps({'text': chunk})}\n\n"
        time.sleep(0.03)
        
    yield "data: [DONE]\n\n"


# -----------------------------------------------------------------------------
# Streaming Chat Endpoint (POST /api/chat) (B5)
# -----------------------------------------------------------------------------
@app.route("/api/chat", methods=["POST"])
@require_auth
def api_chat():
    """
    B5: Authenticated Chat endpoint.
    Rate limiting:
    - Role 'user': Daily limit of VISIONX_USER_DAILY_CHAT_LIMIT messages (default 30). Returns HTTP 429 when exhausted.
    - Role 'developer': Unlimited messages.
    """
    user = getattr(request, "user", {})
    user_id = user.get("id", "anonymous")
    user_role = user.get("role", "user")
    
    # B5: Daily Quota Enforcement per user id ('sub')
    if user_role != "developer":
        today_str = time.strftime("%Y-%m-%d")
        record = user_daily_chat_tracker.get(user_id)
        if not record or record.get("date") != today_str:
            user_daily_chat_tracker[user_id] = {"date": today_str, "count": 0}
        
        current_count = user_daily_chat_tracker[user_id]["count"]
        if current_count >= VISIONX_USER_DAILY_CHAT_LIMIT:
            logger.warning(f"Daily chat limit exceeded for user {user_id} (count: {current_count}/{VISIONX_USER_DAILY_CHAT_LIMIT})")
            return jsonify({
                "error": f"Batas kuota chat harian ({VISIONX_USER_DAILY_CHAT_LIMIT} pesan/hari) telah tercapai. Hubungi developer untuk upgrade.",
                "limit": VISIONX_USER_DAILY_CHAT_LIMIT,
                "current": current_count
            }), 429
        
        user_daily_chat_tracker[user_id]["count"] += 1

    # IP burst rate limiting (30 req/min)
    client_ip = get_client_ip()
    now = time.time()
    if client_ip not in chat_rate_tracker:
        chat_rate_tracker[client_ip] = []
    chat_rate_tracker[client_ip] = [t for t in chat_rate_tracker[client_ip] if t > (now - 60.0)]
    if len(chat_rate_tracker[client_ip]) >= MAX_CHAT_RPM:
        return jsonify({"error": "Chat rate limit exceeded. Please wait a moment."}), 429
    chat_rate_tracker[client_ip].append(now)
    
    # Validate JSON payload
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
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]
        try:
            _ = base64.b64decode(image_b64[:100] + "==")
        except Exception:
            return jsonify({"error": "Invalid base64 encoding for image"}), 400
            
    vision_context = data.get("vision_context")
    detections = data.get("detections")
    history = data.get("history") or []
    
    system_instruction = build_grounded_system_prompt(vision_context, detections)
    
    def generate_chat_stream():
        if not GEMINI_API_KEY:
            yield from stream_local_grounded_response(message, vision_context, detections)
            return
        
        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:streamGenerateContent?alt=sse&key={GEMINI_API_KEY}"
        contents = []
        if isinstance(history, list):
            for turn in history[-6:]:
                if isinstance(turn, dict) and "text" in turn:
                    role = "model" if turn.get("role") in ["assistant", "model"] else "user"
                    contents.append({
                        "role": role,
                        "parts": [{"text": str(turn["text"])}]
                    })
        
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
# DATASET MANAGER ENDPOINTS (B6 - Role 'developer')
# -----------------------------------------------------------------------------

@app.route("/api/manager/stats", methods=["GET"])
@require_role("developer")
def manager_stats():
    """B6: Get dataset summary stats across categories and classes."""
    try:
        total_images = 0
        total_size_bytes = 0
        class_counts: Dict[str, int] = {}
        source_counts: Dict[str, int] = {}

        def scan_stats(cat_dir: str, source_name: str):
            nonlocal total_images, total_size_bytes
            if not os.path.exists(cat_dir):
                return
            for entry in os.scandir(cat_dir):
                if entry.is_dir():
                    cls = entry.name
                    for f in os.scandir(entry.path):
                        if f.is_file() and os.path.splitext(f.name)[1].lower() in ALLOWED_IMAGE_EXTS:
                            st = f.stat()
                            total_images += 1
                            total_size_bytes += st.st_size
                            class_counts[cls] = class_counts.get(cls, 0) + 1
                            source_counts[source_name] = source_counts.get(source_name, 0) + 1

        scan_stats(os.path.join(RAW_DATASET_ROOT, "own"), "own_capture")
        scan_stats(os.path.join(RAW_DATASET_ROOT, "external"), "external")

        trash_count = 0
        if os.path.exists(TRASH_DATASET_ROOT):
            trash_count = len([f for f in os.listdir(TRASH_DATASET_ROOT) if f != ".trash_meta.json"])

        return jsonify({
            "success": True,
            "totalImages": total_images,
            "totalSizeBytes": total_size_bytes,
            "formattedTotalSize": f"{(total_size_bytes / (1024 * 1024)):.2f} MB",
            "classesCount": len(class_counts),
            "classCounts": class_counts,
            "sourceCounts": source_counts,
            "trashCount": trash_count
        }), 200
    except Exception as e:
        logger.error(f"Error in /api/manager/stats: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/manager/list", methods=["GET"])
@require_role("developer")
def manager_list():
    """B6: List active or trashed dataset items with filtering and search."""
    try:
        view = request.args.get("view", "active")
        class_filter = request.args.get("class")
        source_filter = request.args.get("source")
        search = (request.args.get("search") or "").lower().strip()
        items = []

        if view == "trash":
            trash_meta = get_trash_meta()
            meta_items = trash_meta.get("items", {})
            if os.path.exists(TRASH_DATASET_ROOT):
                for f in os.listdir(TRASH_DATASET_ROOT):
                    if f == ".trash_meta.json":
                        continue
                    file_path = os.path.join(TRASH_DATASET_ROOT, f)
                    if os.path.isfile(file_path):
                        info = meta_items.get(f, {})
                        st = os.stat(file_path)
                        items.append({
                            "id": f,
                            "trashFilename": f,
                            "filename": info.get("originalFilename") or f,
                            "className": info.get("originalClass") or "unknown",
                            "source": info.get("originalSource") or "own_capture",
                            "sizeBytes": st.st_size,
                            "formattedSize": f"{(st.st_size / 1024):.1f} KB",
                            "timestamp": info.get("trashedAt") or time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
                            "trashedAt": info.get("trashedAt"),
                            "url": f"/datasets/.trash/{f}",
                            "isTrash": True
                        })
        else:
            def scan_category(cat_dir: str, source_name: str):
                if not os.path.exists(cat_dir):
                    return
                for entry in os.scandir(cat_dir):
                    if entry.is_dir():
                        cls = entry.name
                        for f in os.scandir(entry.path):
                            if f.is_file() and os.path.splitext(f.name)[1].lower() in ALLOWED_IMAGE_EXTS:
                                st = f.stat()
                                items.append({
                                    "id": f.name,
                                    "filename": f.name,
                                    "className": cls,
                                    "source": source_name,
                                    "sizeBytes": st.st_size,
                                    "formattedSize": f"{(st.st_size / 1024):.1f} KB",
                                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
                                    "mtime": st.st_mtime * 1000,
                                    "url": f"/datasets/raw/{'own' if source_name.startswith('own') else 'external'}/{cls}/{f.name}",
                                    "isTrash": False
                                })

            scan_category(os.path.join(RAW_DATASET_ROOT, "own"), "own_capture")
            scan_category(os.path.join(RAW_DATASET_ROOT, "external"), "external")

        filtered = items
        if class_filter and class_filter != "all":
            filtered = [it for it in filtered if it.get("className") == class_filter]
        if source_filter and source_filter != "all":
            filtered = [it for it in filtered if it.get("source") == source_filter]
        if search:
            filtered = [
                it for it in filtered
                if search in it.get("filename", "").lower() or search in it.get("className", "").lower()
            ]

        filtered.sort(key=lambda x: x.get("mtime", 0), reverse=True)
        return jsonify({"success": True, "items": filtered, "total": len(filtered)}), 200
    except Exception as e:
        logger.error(f"Error in /api/manager/list: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/manager/trash", methods=["POST"])
@require_role("developer")
def manager_trash():
    """B6: Soft delete dataset items to .trash with metadata tracking."""
    try:
        data = request.get_json(silent=True) or {}
        items = data.get("items", [])
        if not isinstance(items, list) or len(items) == 0:
            return jsonify({"success": False, "error": "Daftar items kosong."}), 400

        os.makedirs(TRASH_DATASET_ROOT, exist_ok=True)
        trash_meta = get_trash_meta()
        if "items" not in trash_meta:
            trash_meta["items"] = {}

        trashed_count = 0
        for item in items:
            raw_fname = item.get("filename")
            raw_cname = item.get("className")
            source = item.get("source", "own_capture")

            try:
                fname = sanitize_filename(raw_fname)
                cname = sanitize_class_name(raw_cname)
            except ValueError as val_err:
                return jsonify({"success": False, "error": str(val_err)}), 400

            folder_category = "own" if source.startswith("own") else f"external/{source}"
            source_file_path = os.path.join(RAW_DATASET_ROOT, folder_category, cname, fname)
            assert_safe_path(source_file_path, RAW_DATASET_ROOT)

            if os.path.exists(source_file_path):
                trash_filename = f"{int(time.time() * 1000)}_{fname}"
                dest_file_path = os.path.join(TRASH_DATASET_ROOT, trash_filename)
                assert_safe_path(dest_file_path, TRASH_DATASET_ROOT)

                shutil.move(source_file_path, dest_file_path)
                trash_meta["items"][trash_filename] = {
                    "originalFilename": fname,
                    "originalClass": cname,
                    "originalSource": source,
                    "originalFolderCategory": folder_category,
                    "trashedAt": time.strftime("%Y-%m-%d %H:%M:%S")
                }
                trashed_count += 1

        save_trash_meta(trash_meta)
        return jsonify({"success": True, "count": trashed_count}), 200
    except ValueError as val_err:
        return jsonify({"success": False, "error": str(val_err)}), 400
    except Exception as e:
        logger.error(f"Error in /api/manager/trash: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/manager/restore", methods=["POST"])
@require_role("developer")
def manager_restore():
    """B6: Restore dataset items from .trash back to their original folder."""
    try:
        data = request.get_json(silent=True) or {}
        items = data.get("items", [])
        trash_meta = get_trash_meta()
        meta_items = trash_meta.get("items", {})
        restored_count = 0

        for it in items:
            trash_file = it.get("trashFilename") or it.get("id")
            if not trash_file or ".." in trash_file or "/" in trash_file or "\\" in trash_file:
                return jsonify({"success": False, "error": "Invalid trash filename"}), 400

            src_path = os.path.join(TRASH_DATASET_ROOT, trash_file)
            assert_safe_path(src_path, TRASH_DATASET_ROOT)

            if os.path.exists(src_path):
                info = meta_items.get(trash_file, {})
                orig_class_raw = info.get("originalClass") or it.get("className") or "object"
                orig_class = sanitize_class_name(orig_class_raw)
                orig_cat = info.get("originalFolderCategory") or ("own" if info.get("originalSource", "").startswith("own") else "own")
                
                orig_name_raw = info.get("originalFilename") or it.get("filename") or re.sub(r'^\d+_', '', trash_file)
                orig_name = sanitize_filename(orig_name_raw)

                target_dir = os.path.join(RAW_DATASET_ROOT, orig_cat, orig_class)
                os.makedirs(target_dir, exist_ok=True)
                dest_path = os.path.join(target_dir, orig_name)
                assert_safe_path(dest_path, RAW_DATASET_ROOT)

                shutil.move(src_path, dest_path)
                if trash_file in meta_items:
                    del meta_items[trash_file]
                restored_count += 1

        trash_meta["items"] = meta_items
        save_trash_meta(trash_meta)
        return jsonify({"success": True, "count": restored_count}), 200
    except ValueError as val_err:
        return jsonify({"success": False, "error": str(val_err)}), 400
    except Exception as e:
        logger.error(f"Error in /api/manager/restore: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/manager/delete-permanent", methods=["POST"])
@require_role("developer")
def manager_delete_permanent():
    """B6: Permanently remove items from disk and metadata."""
    try:
        data = request.get_json(silent=True) or {}
        items = data.get("items", [])
        trash_meta = get_trash_meta()
        meta_items = trash_meta.get("items", {})
        deleted_count = 0

        for it in items:
            if it.get("fromTrash") or it.get("trashFilename"):
                t_name = it.get("trashFilename") or it.get("id")
                if not t_name or ".." in t_name or "/" in t_name or "\\" in t_name:
                    return jsonify({"success": False, "error": "Invalid trash filename"}), 400
                target_path = os.path.join(TRASH_DATASET_ROOT, t_name)
                assert_safe_path(target_path, TRASH_DATASET_ROOT)
                if t_name in meta_items:
                    del meta_items[t_name]
            else:
                source = it.get("source", "own_capture")
                folder_cat = "own" if source.startswith("own") else f"external/{source}"
                fname = sanitize_filename(it.get("filename"))
                cname = sanitize_class_name(it.get("className"))
                target_path = os.path.join(RAW_DATASET_ROOT, folder_cat, cname, fname)
                assert_safe_path(target_path, RAW_DATASET_ROOT)

            if os.path.exists(target_path):
                os.remove(target_path)
                deleted_count += 1

        trash_meta["items"] = meta_items
        save_trash_meta(trash_meta)
        return jsonify({"success": True, "count": deleted_count}), 200
    except ValueError as val_err:
        return jsonify({"success": False, "error": str(val_err)}), 400
    except Exception as e:
        logger.error(f"Error in /api/manager/delete-permanent: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/manager/import", methods=["POST"])
@require_role("developer")
def manager_import():
    """B6: Import base64 images into physical dataset storage."""
    try:
        data = request.get_json(silent=True) or {}
        files = data.get("files") or ([data] if data.get("dataUrl") else [])
        imported_count = 0
        results = []

        for f in files:
            raw_fname = f.get("filename")
            raw_cname = f.get("className", "object")
            data_url = f.get("dataUrl")

            if not raw_fname or not data_url:
                continue

            fname = sanitize_filename(raw_fname)
            cname = sanitize_class_name(raw_cname)

            target_dir = os.path.join(RAW_DATASET_ROOT, "own", cname)
            os.makedirs(target_dir, exist_ok=True)
            target_path = os.path.join(target_dir, fname)
            assert_safe_path(target_path, RAW_DATASET_ROOT)

            base64_data = re.sub(r'^data:image/\w+;base64,', '', data_url)
            buf = base64.b64decode(base64_data)
            with open(target_path, "wb") as f_out:
                f_out.write(buf)

            imported_count += 1
            results.push if False else results.append({
                "filename": fname,
                "className": cname,
                "sizeBytes": len(buf)
            })

        return jsonify({"success": True, "count": imported_count, "items": results}), 200
    except ValueError as val_err:
        return jsonify({"success": False, "error": str(val_err)}), 400
    except Exception as e:
        logger.error(f"Error in /api/manager/import: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# -----------------------------------------------------------------------------
# DATASET CAPTURE & STORAGE ENDPOINTS (B4, B6 - Role 'developer')
# -----------------------------------------------------------------------------

@app.route("/api/dataset/save", methods=["POST"])
@require_role("developer")
def dataset_save():
    """
    B4 & B6: Save captured camera frame directly to physical dataset storage (/sdcard/AI-Detector).
    Protected by developer role. Strict path traversal prevention.
    """
    try:
        data = request.get_json(silent=True) or {}
        raw_fname = data.get("filename")
        raw_cname = data.get("className")
        source = data.get("source", "own_capture")
        data_url = data.get("dataUrl")
        width = data.get("width")
        height = data.get("height")

        if not raw_fname or not raw_cname or not data_url:
            return jsonify({
                "success": False,
                "error": "Parameter filename, className, atau dataUrl hilang."
            }), 400

        fname = sanitize_filename(raw_fname)
        cname = sanitize_class_name(raw_cname)

        folder_category = "own" if source.startswith("own") else f"external/{source}"
        target_dir = os.path.join(RAW_DATASET_ROOT, folder_category, cname)
        os.makedirs(target_dir, exist_ok=True)

        target_file_path = os.path.join(target_dir, fname)
        assert_safe_path(target_file_path, RAW_DATASET_ROOT)

        base64_data = re.sub(r'^data:image/\w+;base64,', '', data_url)
        buffer = base64.b64decode(base64_data)

        if len(buffer) == 0:
            return jsonify({"success": False, "error": "Buffer citra kosong (0 bytes)."}), 400

        with open(target_file_path, "wb") as f_out:
            f_out.write(buffer)

        stat = os.stat(target_file_path)
        return jsonify({
            "success": True,
            "filename": fname,
            "className": cname,
            "source": source,
            "width": int(width) if width else 0,
            "height": int(height) if height else 0,
            "resolution": f"{width}x{height}" if width and height else "-",
            "sizeBytes": stat.st_size,
            "formattedSize": f"{(stat.st_size / 1024):.1f} KB",
            "path": target_file_path,
            "url": f"/datasets/raw/{folder_category}/{cname}/{fname}",
            "timestamp": time.strftime("%H:%M:%S")
        }), 200
    except ValueError as val_err:
        return jsonify({"success": False, "error": str(val_err)}), 400
    except Exception as e:
        logger.error(f"Error in /api/dataset/save: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/dataset/list", methods=["GET"])
@require_role("developer")
def dataset_list():
    """B6: List captured dataset images for a given class."""
    try:
        requested_class = request.args.get("className")
        items = []
        own_dir = os.path.join(RAW_DATASET_ROOT, "own")

        if os.path.exists(own_dir):
            for entry in os.scandir(own_dir):
                if entry.is_dir():
                    cls = entry.name
                    if requested_class and requested_class != cls:
                        continue
                    for f in os.scandir(entry.path):
                        if f.is_file() and os.path.splitext(f.name)[1].lower() in ALLOWED_IMAGE_EXTS:
                            st = f.stat()
                            items.append({
                                "filename": f.name,
                                "className": cls,
                                "source": "own_capture",
                                "sizeBytes": st.st_size,
                                "formattedSize": f"{(st.st_size / 1024):.1f} KB",
                                "timestamp": time.strftime("%H:%M:%S", time.localtime(st.st_mtime)),
                                "mtime": st.st_mtime * 1000,
                                "url": f"/datasets/raw/own/{cls}/{f.name}"
                            })

        items.sort(key=lambda x: x.get("mtime", 0), reverse=True)
        return jsonify({"success": True, "items": items}), 200
    except Exception as e:
        logger.error(f"Error in /api/dataset/list: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/dataset/delete", methods=["POST"])
@require_role("developer")
def dataset_delete():
    """B6: Delete an image file from the dataset."""
    try:
        data = request.get_json(silent=True) or {}
        raw_fname = data.get("filename")
        raw_cname = data.get("className")
        source = data.get("source", "own_capture")

        if not raw_fname or not raw_cname:
            return jsonify({
                "success": False,
                "error": "Parameter filename atau className hilang."
            }), 400

        fname = sanitize_filename(raw_fname)
        cname = sanitize_class_name(raw_cname)

        folder_category = "own" if source.startswith("own") else f"external/{source}"
        target_path = os.path.join(RAW_DATASET_ROOT, folder_category, cname, fname)
        assert_safe_path(target_path, RAW_DATASET_ROOT)

        deleted = False
        if os.path.exists(target_path):
            os.remove(target_path)
            deleted = True

        return jsonify({
            "success": True,
            "deleted": deleted,
            "filename": fname,
            "className": cname
        }), 200
    except ValueError as val_err:
        return jsonify({"success": False, "error": str(val_err)}), 400
    except Exception as e:
        logger.error(f"Error in /api/dataset/delete: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# -----------------------------------------------------------------------------
# IDENTITY LAB ENDPOINTS (B6 - Role 'developer')
# -----------------------------------------------------------------------------

@app.route("/api/identity/profile", methods=["GET"])
@require_role("developer")
def identity_profile():
    """B6: Get developer face profile information."""
    try:
        mgr = get_identity_manager()
        refs = mgr.list_reference_images()
        return jsonify({
            "success": True,
            "profile_id": mgr.profile_id,
            "profile_name": mgr.profile_name,
            "registered": True,
            "reference_count": len(refs),
            "threshold": mgr.threshold,
            "enrolled_count": len(mgr.metadata.get("enrolled_references", []))
        }), 200
    except Exception as e:
        logger.error(f"Error in /api/identity/profile: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/identity/references", methods=["GET"])
@require_role("developer")
def identity_references():
    """B6: List reference images enrolled for the developer profile."""
    try:
        mgr = get_identity_manager()
        refs = mgr.list_reference_images()
        for r in refs:
            r["url"] = f"/datasets/faces/developer/{r['filename']}"
        return jsonify({"success": True, "references": refs, "count": len(refs)}), 200
    except Exception as e:
        logger.error(f"Error in /api/identity/references: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/identity/register", methods=["POST"])
@require_role("developer")
def identity_register():
    """B6: Register or update developer profile name."""
    try:
        mgr = get_identity_manager()
        data = request.get_json(silent=True) or {}
        name = data.get("name", "VisionX Developer")
        res = mgr.register_profile(name)
        return jsonify({"success": True, "profile": res}), 200
    except Exception as e:
        logger.error(f"Error in /api/identity/register: {e}")
        return jsonify({"success": False, "error": str(e)}), 400


@app.route("/api/identity/add-reference", methods=["POST"])
@require_role("developer")
def identity_add_reference():
    """B6: Enroll new reference image for developer identity."""
    try:
        mgr = get_identity_manager()
        data = request.get_json(silent=True) or {}
        data_url = data.get("dataUrl")
        filename = data.get("filename")

        if not data_url:
            return jsonify({"success": False, "error": "Parameter dataUrl wajib diberikan."}), 400

        if filename:
            filename = sanitize_filename(filename)

        img = decode_base64_image(data_url)
        res = mgr.add_reference_image(img, filename)
        return jsonify(res), 200
    except ValueError as val_err:
        return jsonify({"success": False, "error": str(val_err)}), 400
    except Exception as e:
        logger.error(f"Error in /api/identity/add-reference: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/identity/delete-reference", methods=["POST"])
@require_role("developer")
def identity_delete_reference():
    """B6: Remove an enrolled face reference image."""
    try:
        mgr = get_identity_manager()
        data = request.get_json(silent=True) or {}
        raw_fname = data.get("filename")

        if not raw_fname:
            return jsonify({"success": False, "error": "Parameter filename wajib diberikan."}), 400

        fname = sanitize_filename(raw_fname)
        ok = mgr.delete_reference_image(fname)
        return jsonify({"success": True, "deleted": ok, "filename": fname}), 200
    except ValueError as val_err:
        return jsonify({"success": False, "error": str(val_err)}), 400
    except Exception as e:
        logger.error(f"Error in /api/identity/delete-reference: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/identity/detect", methods=["POST"])
@require_role("developer")
def identity_detect():
    """B6: Detect faces and landmarks in image."""
    try:
        mgr = get_identity_manager()
        data = request.get_json(silent=True) or {}
        data_url = data.get("dataUrl")

        if not data_url:
            return jsonify({"success": False, "error": "Parameter dataUrl wajib diberikan."}), 400

        img = decode_base64_image(data_url)
        res = mgr.detect_faces(img)
        return jsonify(res), 200
    except Exception as e:
        logger.error(f"Error in /api/identity/detect: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/identity/match", methods=["POST"])
@require_role("developer")
def identity_match():
    """B6: Match face in image against enrolled developer profile."""
    try:
        mgr = get_identity_manager()
        data = request.get_json(silent=True) or {}
        data_url = data.get("dataUrl")
        thresh = data.get("threshold", DEFAULT_THRESHOLD)

        if not data_url:
            return jsonify({"success": False, "error": "Parameter dataUrl wajib diberikan."}), 400

        img = decode_base64_image(data_url)
        res = mgr.match_face(img, threshold=float(thresh))
        return jsonify({"success": True, **res}), 200
    except Exception as e:
        logger.error(f"Error in /api/identity/match: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# -----------------------------------------------------------------------------
# Main Entrypoint
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    logger.info(f"Starting VisionX Production Gateway on port {APP_PORT}...")
    logger.info(f"Storage path: {STORAGE_BASE_DIR}")
    logger.info(f"Allowed CORS Origins: {ALLOWED_ORIGINS}")
    app.run(host="0.0.0.0", port=APP_PORT, threaded=True)
