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

from flask import Flask, request, Response, jsonify, stream_with_context, send_from_directory, send_file
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
import requests
import jwt
from jwt import PyJWKClient, PyJWKClientError
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

# Optional dotenv loading for Termux / local environment
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent / ".env"
    if _env_path.exists():
        load_dotenv(dotenv_path=_env_path)
    else:
        load_dotenv()
except Exception:
    pass

# Supabase Auth Configuration
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://wnwaniiuflsuemyambuy.supabase.co").rstrip("/")
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
SUPABASE_AUDIENCE = os.environ.get("SUPABASE_AUDIENCE", "authenticated")

# Supabase JWKS Client for asymmetric tokens (ES256 / RS256)
jwks_url = f"{SUPABASE_URL.rstrip('/')}/auth/v1/.well-known/jwks.json"
jwks_client = PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=3600)

# Rate Limiting Configuration
VISIONX_USER_DAILY_CHAT_LIMIT = int(os.environ.get("VISIONX_USER_DAILY_CHAT_LIMIT", 30))

# AI Provider Configuration (OpenAI-compatible / Groq Cloud)
AI_BASE_URL = os.environ.get("AI_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
AI_API_KEY = os.environ.get("AI_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "llama-3.3-70b-versatile")
AI_FALLBACK_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]

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


# Backward compatibility alias for legacy tests
verify_token = verify_legacy_token


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
        try:
            unverified_header = jwt.get_unverified_header(token_str)
            alg = unverified_header.get("alg", "HS256")
        except Exception as header_err:
            logger.warning(f"Failed to read JWT header: {header_err}")
            return None, "Malformed token format", 401

        decode_kwargs: Dict[str, Any] = {
            "options": {
                "verify_exp": True,
                "verify_aud": True
            }
        }
        if SUPABASE_AUDIENCE:
            decode_kwargs["audience"] = SUPABASE_AUDIENCE

        try:
            if alg in ("ES256", "RS256"):
                signing_key = jwks_client.get_signing_key_from_jwt(token_str)
                decode_kwargs["algorithms"] = [alg]
                payload = jwt.decode(token_str, signing_key.key, **decode_kwargs)
            elif alg == "HS256":
                if not SUPABASE_JWT_SECRET:
                    logger.error("SUPABASE_JWT_SECRET is not configured on the server")
                    return None, "Supabase authentication secret is not configured on backend", 500
                decode_kwargs["algorithms"] = ["HS256"]
                payload = jwt.decode(token_str, SUPABASE_JWT_SECRET, **decode_kwargs)
            else:
                logger.warning(f"Unsupported JWT algorithm: {alg}")
                return None, f"Unsupported JWT algorithm: {alg}", 401

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
        except (InvalidTokenError, PyJWKClientError) as err:
            logger.warning(f"Supabase JWT validation failed: {str(err)}")
            return None, f"Invalid token: {str(err)}", 401
        except Exception as err:
            logger.error(f"Unexpected error validating JWT: {str(err)}")
            return None, f"Token verification failed: {str(err)}", 401

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
        return None
    
    if _identity_manager_instance is None:
        try:
            _identity_manager_instance = IdentityManager(faces_dir=Path(FACES_DATASET_ROOT))
        except Exception as _mgr_err:
            logger.warning(f"Could not initialize IdentityManager: {_mgr_err}")
            return None
    return _identity_manager_instance


def decode_base64_image(base64_str: str):
    """Decode dataUrl base64 string to BGR OpenCV image, or raw bytes if OpenCV missing."""
    if "," in base64_str:
        base64_str = base64_str.split(",", 1)[1]
    img_bytes = base64.b64decode(base64_str)
    if not HAVE_IDENTITY_MODULE or cv2 is None or np is None:
        return img_bytes
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return img_bytes
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
        "ai_provider": "Groq (Llama 3.3)",
        "ai_model": AI_MODEL,
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
        "ai_provider": "Groq (Llama 3.3)",
        "ai_model": AI_MODEL,
        "auth_enabled": True,
        "legacy_pin_enabled": VISIONX_LEGACY_PIN,
        "streaming_enabled": True
    }), 200


@app.route("/api/config", methods=["GET"])
def api_config():
    return jsonify({
        "service": "visionx",
        "ai_provider": "Groq (Llama 3.3)",
        "ai_model": AI_MODEL,
        "status": "online"
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
# Dataset & Collection Upload Routes (POST & OPTIONS /api/dataset/upload, /api/collection/save)
# -----------------------------------------------------------------------------
@app.route("/api/dataset/upload", methods=["POST", "OPTIONS"])
@app.route("/api/collection/save", methods=["POST", "OPTIONS"])
def api_dataset_upload():
    """
    Endpoint for dataset collection uploads.
    Accepts:
    - Multipart form-data: image file in 'image' or 'file', and label/className in 'label', 'className', or 'info'.
    - JSON base64: { "image": "data:image/jpeg;base64,...", "label": "earphone" }.
    Saves image into local datasets storage directory (RAW_DATASET_ROOT/own/<clean_label>).
    Returns:
    { "success": true, "message": "Dataset tersimpan", "filename": filename }
    """
    if request.method == "OPTIONS":
        return "", 204

    try:
        image_bytes = None
        label = "object"
        filename = None

        # 1. Parse Multipart form-data
        if request.files:
            file = request.files.get("image") or request.files.get("file")
            if file and file.filename:
                try:
                    filename = sanitize_filename(file.filename)
                except Exception:
                    filename = os.path.basename(file.filename)
                image_bytes = file.read()
            
            form_label = request.form.get("label") or request.form.get("className")
            if form_label:
                label = form_label.strip()
            elif "info" in request.form:
                info_raw = request.form.get("info", "")
                try:
                    info_json = json.loads(info_raw)
                    label = info_json.get("className") or info_json.get("label") or label
                    if not filename and "filename" in info_json:
                        filename = sanitize_filename(info_json["filename"])
                except Exception:
                    label = info_raw.strip() or label

        # 2. Parse JSON base64 payload
        if not image_bytes:
            data = request.get_json(silent=True)
            if data and isinstance(data, dict):
                b64_str = data.get("image") or data.get("dataUrl") or data.get("data")
                if b64_str and isinstance(b64_str, str):
                    if "," in b64_str:
                        b64_str = b64_str.split(",", 1)[1]
                    try:
                        image_bytes = base64.b64decode(b64_str)
                    except Exception as b64_err:
                        return jsonify({"success": False, "error": f"Invalid base64 encoding: {str(b64_err)}"}), 400
                
                label = data.get("label") or data.get("className") or label
                if "filename" in data and not filename:
                    try:
                        filename = sanitize_filename(str(data["filename"]))
                    except Exception:
                        pass

        if not image_bytes or len(image_bytes) == 0:
            return jsonify({"success": False, "message": "Tidak ada data citra yang valid (multipart atau base64)"}), 400

        # Normalisasi nama kelas/label
        clean_label = re.sub(r'[^a-zA-Z0-9_\-]', '_', label.strip().lower()) or "object"

        # Buat nama file jika belum ada
        if not filename:
            filename = f"{clean_label}_{int(time.time() * 1000)}.jpg"
        elif not (filename.endswith(".jpg") or filename.endswith(".jpeg") or filename.endswith(".png") or filename.endswith(".webp")):
            filename = f"{filename}.jpg"

        # Target penyimpanan fisik di folder dataset lokal
        target_dir = os.path.join(RAW_DATASET_ROOT, "own", clean_label)
        os.makedirs(target_dir, exist_ok=True)
        dest_path = os.path.join(target_dir, filename)

        with open(dest_path, "wb") as f_out:
            f_out.write(image_bytes)

        logger.info(f"Dataset image saved: {dest_path} ({len(image_bytes)} bytes, label: {clean_label})")

        return jsonify({
            "success": True,
            "status": "success",
            "message": "Dataset tersimpan",
            "filename": filename,
            "label": clean_label,
            "size": len(image_bytes),
            "path": dest_path
        }), 200

    except Exception as e:
        logger.error(f"Error in dataset upload: {str(e)}")
        return jsonify({
            "success": False,
            "status": "error",
            "message": f"Gagal menyimpan dataset: {str(e)}"
        }), 500


# -----------------------------------------------------------------------------
# VisionX Grounding Prompt Construction
# -----------------------------------------------------------------------------
def build_grounded_system_prompt(vision_context: Optional[Dict[str, Any]] = None, detections: Optional[List[Any]] = None) -> str:
    """Builds strict VisionX grounding instruction."""
    prompt = (
        "Kamu adalah VisionX AI Assistant, asisten visual dan deteksi cerdas yang ramah, ringkas, dan berbahasa Indonesia.\n"
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
                conf_raw = d.get("confidence")
                try:
                    conf = float(conf_raw) if conf_raw is not None else 0.0
                except (ValueError, TypeError):
                    conf = 0.0
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
        if not AI_API_KEY:
            yield from stream_local_grounded_response(message, vision_context, detections)
            return
        
        endpoint = f"{AI_BASE_URL}/chat/completions"
        headers = {
            "Authorization": f"Bearer {AI_API_KEY}",
            "Content-Type": "application/json"
        }
        
        # Build OpenAI-compatible messages array with Indonesian system prompt
        base_system_prompt = "Kamu adalah VisionX AI Assistant, asisten visual dan deteksi cerdas yang ramah, ringkas, dan berbahasa Indonesia."
        if vision_context or detections:
            system_prompt = f"{base_system_prompt}\n\n{system_instruction}"
        else:
            system_prompt = base_system_prompt
            
        messages = [
            {"role": "system", "content": system_prompt}
        ]
        
        # Append conversation history (last 6 turns)
        if isinstance(history, list):
            for turn in history[-6:]:
                if isinstance(turn, dict) and "text" in turn:
                    t_text = str(turn["text"]).strip()
                    if not t_text:
                        continue
                    role = "assistant" if turn.get("role") in ["assistant", "model"] else "user"
                    # Merge consecutive same-role messages
                    if messages and messages[-1]["role"] == role:
                        messages[-1]["content"] += f"\n{t_text}"
                    else:
                        messages.append({"role": role, "content": t_text})
        
        # Build current user message content
        user_message = message
        if image_b64:
            # Multimodal: use content array with text + image_url (vision format)
            user_content = [
                {"type": "text", "text": user_message},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{image_b64}"
                    }
                }
            ]
        else:
            user_content = user_message
        
        # Merge or append user message
        if messages and messages[-1]["role"] == "user":
            prev = messages[-1]["content"]
            if isinstance(prev, str) and isinstance(user_content, str):
                messages[-1]["content"] = f"{prev}\n{user_content}"
            else:
                prev_list = [{"type": "text", "text": prev}] if isinstance(prev, str) else prev
                curr_list = [{"type": "text", "text": user_content}] if isinstance(user_content, str) else user_content
                messages[-1]["content"] = prev_list + curr_list
        else:
            messages.append({"role": "user", "content": user_content})
        
        # Candidate models: prioritize AI_MODEL or vision-capable model
        if image_b64:
            candidate_models = ["qwen/qwen3.8-27b", AI_MODEL]
            for m in AI_FALLBACK_MODELS:
                if m not in candidate_models:
                    candidate_models.append(m)
        else:
            candidate_models = [AI_MODEL]
            for m in AI_FALLBACK_MODELS:
                if m not in candidate_models:
                    candidate_models.append(m)

        active_resp = None
        last_error_text = ""
        last_status_code = None

        for target_model in candidate_models:
            # Format messages for target model (convert multimodal to text if model is text-only)
            model_messages = []
            for m in messages:
                m_content = m.get("content")
                if isinstance(m_content, list) and not target_model.startswith("qwen/"):
                    text_parts = [p.get("text", "") for p in m_content if isinstance(p, dict) and p.get("type") == "text"]
                    combined = " ".join([tp for tp in text_parts if tp]).strip()
                    model_messages.append({
                        "role": m["role"],
                        "content": (combined or user_message) + "\n[Catatan visual: Pengguna menyertakan gambar]"
                    })
                else:
                    model_messages.append(m)

            payload = {
                "model": target_model,
                "messages": model_messages,
                "stream": True,
                "temperature": 0.7
            }

            try:
                resp = requests.post(endpoint, json=payload, headers=headers, stream=True, timeout=60)
                if resp.status_code == 200:
                    active_resp = resp
                    break
                else:
                    last_status_code = resp.status_code
                    last_error_text = resp.text if hasattr(resp, "text") else f"HTTP {resp.status_code}"
                    print(f"[Groq Cloud Error] Model '{target_model}' returned HTTP {resp.status_code}: {last_error_text}")
                    logger.warning(f"[Groq Cloud Error] Model '{target_model}' returned HTTP {resp.status_code}: {last_error_text}")
                    resp.close()
            except Exception as conn_err:
                last_error_text = str(conn_err)
                print(f"[Groq Cloud Error] Connection error for model '{target_model}': {conn_err}")
                logger.warning(f"[Groq Cloud Error] Connection error for model '{target_model}': {conn_err}")

        if not active_resp:
            print(f"[Groq Cloud Fatal] Upstream chat completions failed for all models. Status: {last_status_code}, error: {last_error_text}")
            logger.error(f"[Groq Cloud Fatal] Status: {last_status_code}, error: {last_error_text}")
            err_msg = f"Groq Cloud error (HTTP {last_status_code or 500}): {last_error_text}"
            yield f"data: {json.dumps({'error': err_msg})}\n\n"
            yield "data: [DONE]\n\n"
            return

        try:
            with active_resp as resp:
                for line in resp.iter_lines():
                    if line:
                        decoded_line = line.decode("utf-8")
                        if decoded_line.startswith("data: "):
                            raw_data = decoded_line[6:].strip()
                            if raw_data == "[DONE]":
                                break
                            try:
                                chunk_data = json.loads(raw_data)
                                choices = chunk_data.get("choices", [])
                                if choices:
                                    delta = choices[0].get("delta", {})
                                    chunk_text = delta.get("content", "")
                                    if chunk_text:
                                        yield f"data: {json.dumps({'text': chunk_text})}\n\n"
                            except Exception:
                                continue
            yield "data: [DONE]\n\n"
        except requests.Timeout:
            print("[Groq Cloud Error] Streaming request timed out (60s)")
            logger.error("AI provider request timed out (60s)")
            yield f"data: {json.dumps({'error': 'AI provider request timed out (60s)'})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as err:
            print(f"[Groq Cloud Error] Stream error: {err}")
            logger.error(f"Error streaming from AI provider: {str(err)}")
            yield f"data: {json.dumps({'error': f'AI provider stream error: {str(err)}'})}\n\n"
            yield "data: [DONE]\n\n"

    try:
        return Response(
            stream_with_context(generate_chat_stream()),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"
            }
        )
    except Exception as stream_err:
        logger.exception(f"Error initializing chat stream: {stream_err}")
        return jsonify({"error": f"Failed to start chat stream: {str(stream_err)}"}), 500


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
                            "url": f"/api/dataset/file/.trash/{f}",
                            "isTrash": True
                        })
        else:
            if os.path.exists(RAW_DATASET_ROOT):
                for root, _, files in os.walk(RAW_DATASET_ROOT):
                    if ".trash" in root:
                        continue
                    for f in files:
                        if os.path.splitext(f)[1].lower() in ALLOWED_IMAGE_EXTS:
                            full_path = os.path.join(root, f)
                            rel_path = os.path.relpath(full_path, RAW_DATASET_ROOT)
                            parts = Path(rel_path).parts
                            
                            if len(parts) >= 3 and parts[0] == "own":
                                cls = parts[1]
                                source_name = "own_capture"
                            elif len(parts) >= 4 and parts[0] == "external":
                                cls = parts[2]
                                source_name = f"external/{parts[1]}"
                            elif len(parts) >= 2:
                                cls = parts[0]
                                source_name = "own_capture"
                            else:
                                cls = "general"
                                source_name = "own_capture"

                            st = os.stat(full_path)
                            url_rel = rel_path.replace(os.sep, "/")
                            items.append({
                                "id": f,
                                "filename": f,
                                "className": cls,
                                "source": source_name,
                                "sizeBytes": st.st_size,
                                "formattedSize": f"{(st.st_size / 1024):.1f} KB",
                                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
                                "mtime": st.st_mtime * 1000,
                                "url": f"/api/dataset/file/{url_rel}",
                                "isTrash": False
                            })

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
    """B6: Comprehensive scan of all dataset images stored on disk, separating active and trash."""
    try:
        requested_class = request.args.get("className") or request.args.get("class")
        requested_source = request.args.get("source")
        search = (request.args.get("search") or "").lower().strip()
        view = (request.args.get("view") or "active").lower().strip()
        
        active_items = []
        trash_items = []

        # 1. Scan active items in RAW_DATASET_ROOT
        if os.path.exists(RAW_DATASET_ROOT):
            for root, dirs, files in os.walk(RAW_DATASET_ROOT):
                if ".trash" in root:
                    continue
                for f_name in files:
                    ext = os.path.splitext(f_name)[1].lower()
                    if ext in ALLOWED_IMAGE_EXTS:
                        full_path = os.path.join(root, f_name)
                        rel_path = os.path.relpath(full_path, RAW_DATASET_ROOT)
                        parts = Path(rel_path).parts
                        
                        if len(parts) >= 3 and parts[0] == "own":
                            cls = parts[1]
                            source = "own_capture"
                        elif len(parts) >= 4 and parts[0] == "external":
                            cls = parts[2]
                            source = f"external/{parts[1]}"
                        elif len(parts) >= 2:
                            cls = parts[0]
                            source = "own_capture"
                        else:
                            cls = "general"
                            source = "own_capture"

                        if requested_class and requested_class != "all" and requested_class != cls:
                            continue
                        if requested_source and requested_source != "all" and requested_source != source:
                            continue
                        if search and (search not in f_name.lower() and search not in cls.lower()):
                            continue

                        st = os.stat(full_path)
                        url_path = rel_path.replace(os.sep, "/")
                        active_items.append({
                            "id": f_name,
                            "filename": f_name,
                            "className": cls,
                            "source": source,
                            "sizeBytes": st.st_size,
                            "formattedSize": f"{(st.st_size / 1024):.1f} KB",
                            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
                            "mtime": st.st_mtime * 1000,
                            "url": f"/api/dataset/image/{url_path}",
                            "isTrash": False
                        })

        # 2. Scan trash items in TRASH_DATASET_ROOT
        trash_meta = get_trash_meta()
        meta_items = trash_meta.get("items", {})
        if os.path.exists(TRASH_DATASET_ROOT):
            for f_name in os.listdir(TRASH_DATASET_ROOT):
                if f_name == ".trash_meta.json":
                    continue
                full_path = os.path.join(TRASH_DATASET_ROOT, f_name)
                if os.path.isfile(full_path) and os.path.splitext(f_name)[1].lower() in ALLOWED_IMAGE_EXTS:
                    info = meta_items.get(f_name, {})
                    orig_fname = info.get("originalFilename") or f_name
                    orig_cls = info.get("originalClass") or "unknown"
                    orig_src = info.get("originalSource") or "own_capture"

                    if requested_class and requested_class != "all" and requested_class != orig_cls:
                        continue
                    if requested_source and requested_source != "all" and requested_source != orig_src:
                        continue
                    if search and (search not in orig_fname.lower() and search not in orig_cls.lower()):
                        continue

                    st = os.stat(full_path)
                    trash_items.append({
                        "id": f_name,
                        "trashFilename": f_name,
                        "filename": orig_fname,
                        "className": orig_cls,
                        "source": orig_src,
                        "sizeBytes": st.st_size,
                        "formattedSize": f"{(st.st_size / 1024):.1f} KB",
                        "timestamp": info.get("trashedAt") or time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
                        "mtime": st.st_mtime * 1000,
                        "url": f"/api/dataset/image/.trash/{f_name}",
                        "isTrash": True
                    })

        active_items.sort(key=lambda x: x.get("mtime", 0), reverse=True)
        trash_items.sort(key=lambda x: x.get("mtime", 0), reverse=True)

        selected_items = trash_items if view == "trash" else active_items

        return jsonify({
            "success": True,
            "items": selected_items,
            "active": active_items,
            "trash": trash_items,
            "active_count": len(active_items),
            "trash_count": len(trash_items),
            "count": len(selected_items),
            "total": len(active_items)
        }), 200
    except Exception as e:
        logger.error(f"Error in /api/dataset/list: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/dataset/image/<path:filename>", methods=["GET"])
@app.route("/api/dataset/file/<path:filename>", methods=["GET"])
def dataset_file(filename):
    """Serve dataset and face images statically so thumbnails do not 404/broken."""
    try:
        clean_path = os.path.normpath(filename).lstrip(os.sep).lstrip("/").lstrip("\\")
        if ".." in clean_path:
            return jsonify({"success": False, "error": "Invalid path"}), 400

        mimetypes_map = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".bmp": "image/bmp"
        }

        def _send(fpath):
            ext = os.path.splitext(fpath)[1].lower()
            mt = mimetypes_map.get(ext, "image/jpeg")
            return send_file(fpath, mimetype=mt)

        # 1. Direct in RAW_DATASET_ROOT
        cand = os.path.join(RAW_DATASET_ROOT, clean_path)
        if os.path.isfile(cand):
            return _send(cand)

        # 2. Check in TRASH_DATASET_ROOT
        if clean_path.startswith(".trash") or clean_path.startswith("trash"):
            sub_name = clean_path.split(os.sep, 1)[-1].split("/", 1)[-1]
            cand = os.path.join(TRASH_DATASET_ROOT, sub_name)
            if os.path.isfile(cand):
                return _send(cand)
        cand = os.path.join(TRASH_DATASET_ROOT, clean_path)
        if os.path.isfile(cand):
            return _send(cand)

        # 3. Check in FACES_DATASET_ROOT
        if "faces" in clean_path:
            sub_name = os.path.basename(clean_path)
            cand = os.path.join(FACES_DATASET_ROOT, sub_name)
            if os.path.isfile(cand):
                return _send(cand)
        cand = os.path.join(FACES_DATASET_ROOT, clean_path)
        if os.path.isfile(cand):
            return _send(cand)

        # 4. Check directly in STORAGE_BASE_DIR
        cand = os.path.join(STORAGE_BASE_DIR, clean_path)
        if os.path.isfile(cand):
            return _send(cand)

        # 5. Search by basename across STORAGE_BASE_DIR and TRASH_DATASET_ROOT
        target_name = os.path.basename(clean_path)
        for root, _, files in os.walk(STORAGE_BASE_DIR):
            if target_name in files:
                return _send(os.path.join(root, target_name))

        if os.path.exists(TRASH_DATASET_ROOT):
            cand = os.path.join(TRASH_DATASET_ROOT, target_name)
            if os.path.isfile(cand):
                return _send(cand)

        return jsonify({"success": False, "error": f"Image '{filename}' not found"}), 404
    except Exception as e:
        logger.error(f"Error serving dataset file '{filename}': {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/datasets/<path:filename>", methods=["GET"])
def dataset_legacy_file(filename):
    """Legacy static route for /datasets/raw/... or /datasets/faces/..."""
    return dataset_file(filename)


@app.route("/api/dataset/trash", methods=["POST", "OPTIONS"])
@require_role("developer")
def dataset_trash():
    """Soft delete dataset items: move from active dataset folder to .trash."""
    try:
        data = request.get_json(silent=True) or {}
        filenames = data.get("filenames")
        if filenames is None:
            items = data.get("items", [])
            if isinstance(items, list):
                filenames = [it.get("filename") if isinstance(it, dict) else it for it in items]
            elif "filename" in data:
                filenames = [data["filename"]]
            else:
                filenames = []

        if not filenames:
            return jsonify({"success": False, "error": "Parameter filenames kosong."}), 400

        os.makedirs(TRASH_DATASET_ROOT, exist_ok=True)
        trash_meta = get_trash_meta()
        if "items" not in trash_meta:
            trash_meta["items"] = {}

        moved = []
        for raw_name in filenames:
            if not raw_name:
                continue
            fname = os.path.basename(str(raw_name))

            found_src = None
            found_rel = None
            found_cls = "unknown"
            found_src_type = "own_capture"

            for root, dirs, files in os.walk(RAW_DATASET_ROOT):
                if ".trash" in root:
                    continue
                if fname in files:
                    found_src = os.path.join(root, fname)
                    found_rel = os.path.relpath(found_src, RAW_DATASET_ROOT)
                    parts = Path(found_rel).parts
                    if len(parts) >= 3 and parts[0] == "own":
                        found_cls = parts[1]
                    elif len(parts) >= 4 and parts[0] == "external":
                        found_cls = parts[2]
                        found_src_type = f"external/{parts[1]}"
                    elif len(parts) >= 2:
                        found_cls = parts[0]
                    break

            if found_src and os.path.isfile(found_src):
                assert_safe_path(found_src, RAW_DATASET_ROOT)
                dest_file_path = os.path.join(TRASH_DATASET_ROOT, fname)
                assert_safe_path(dest_file_path, TRASH_DATASET_ROOT)

                shutil.move(found_src, dest_file_path)
                trash_meta["items"][fname] = {
                    "originalFilename": fname,
                    "originalRelPath": found_rel,
                    "originalClass": found_cls,
                    "originalSource": found_src_type,
                    "trashedAt": time.strftime("%Y-%m-%d %H:%M:%S")
                }
                moved.append(fname)

        save_trash_meta(trash_meta)
        return jsonify({
            "success": True,
            "moved": moved,
            "count": len(moved)
        }), 200
    except Exception as e:
        logger.error(f"Error in /api/dataset/trash: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/dataset/permanent", methods=["DELETE", "POST"])
@require_role("developer")
def dataset_permanent():
    """Permanently delete files from disk using os.remove()."""
    try:
        data = request.get_json(silent=True) or {}
        filenames = data.get("filenames")
        if filenames is None:
            items = data.get("items", [])
            if isinstance(items, list):
                filenames = [it.get("trashFilename") or it.get("filename") if isinstance(it, dict) else it for it in items]
            elif "filename" in data:
                filenames = [data["filename"]]
            else:
                filenames = []

        if not filenames:
            return jsonify({"success": False, "error": "Parameter filenames kosong."}), 400

        trash_meta = get_trash_meta()
        meta_items = trash_meta.get("items", {})
        deleted = []

        for raw_name in filenames:
            if not raw_name:
                continue
            fname = os.path.basename(str(raw_name))

            # 1. Check in TRASH_DATASET_ROOT
            target = os.path.join(TRASH_DATASET_ROOT, fname)
            if os.path.isfile(target):
                assert_safe_path(target, TRASH_DATASET_ROOT)
                os.remove(target)
                deleted.append(fname)
                if fname in meta_items:
                    del meta_items[fname]
                continue

            # 2. Check across RAW_DATASET_ROOT
            for root, _, files in os.walk(RAW_DATASET_ROOT):
                if fname in files:
                    fpath = os.path.join(root, fname)
                    assert_safe_path(fpath, RAW_DATASET_ROOT)
                    os.remove(fpath)
                    deleted.append(fname)
                    break

        trash_meta["items"] = meta_items
        save_trash_meta(trash_meta)

        return jsonify({
            "success": True,
            "deleted": deleted,
            "count": len(deleted)
        }), 200
    except Exception as e:
        logger.error(f"Error in /api/dataset/permanent: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/dataset/restore", methods=["POST"])
@require_role("developer")
def dataset_restore():
    """Restore dataset items from .trash back to their original folder."""
    try:
        data = request.get_json(silent=True) or {}
        filenames = data.get("filenames")
        if filenames is None:
            items = data.get("items", [])
            if isinstance(items, list):
                filenames = [it.get("trashFilename") or it.get("filename") if isinstance(it, dict) else it for it in items]
            elif "filename" in data:
                filenames = [data["filename"]]
            else:
                filenames = []

        if not filenames:
            return jsonify({"success": False, "error": "Parameter filenames kosong."}), 400

        trash_meta = get_trash_meta()
        meta_items = trash_meta.get("items", {})
        restored = []

        for raw_name in filenames:
            if not raw_name:
                continue
            fname = os.path.basename(str(raw_name))
            src_path = os.path.join(TRASH_DATASET_ROOT, fname)

            if os.path.isfile(src_path):
                assert_safe_path(src_path, TRASH_DATASET_ROOT)
                info = meta_items.get(fname, {})
                orig_rel = info.get("originalRelPath")
                orig_cls = info.get("originalClass") or "object"

                if orig_rel:
                    dest_path = os.path.join(RAW_DATASET_ROOT, orig_rel)
                else:
                    dest_path = os.path.join(RAW_DATASET_ROOT, "own", orig_cls, fname)

                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                assert_safe_path(dest_path, RAW_DATASET_ROOT)
                shutil.move(src_path, dest_path)
                restored.append(fname)
                if fname in meta_items:
                    del meta_items[fname]

        trash_meta["items"] = meta_items
        save_trash_meta(trash_meta)

        return jsonify({
            "success": True,
            "restored": restored,
            "count": len(restored)
        }), 200
    except Exception as e:
        logger.error(f"Error in /api/dataset/restore: {e}")
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
        else:
            for root, _, files in os.walk(RAW_DATASET_ROOT):
                if fname in files:
                    os.remove(os.path.join(root, fname))
                    deleted = True
                    break

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
        profile_name = "VisionX Developer"
        threshold = 0.60
        enrolled_count = 0

        profile_json = os.path.join(FACES_DATASET_ROOT, "developer_profile.json")
        if os.path.isfile(profile_json):
            try:
                with open(profile_json, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                    profile_name = meta.get("profile_name", profile_name)
                    threshold = meta.get("threshold", threshold)
            except Exception:
                pass

        if mgr is not None:
            refs = mgr.list_reference_images()
            ref_count = len(refs)
            profile_name = mgr.profile_name
            threshold = mgr.threshold
            enrolled_count = len(mgr.metadata.get("enrolled_references", []))
        else:
            disk_files = []
            if os.path.exists(FACES_DATASET_ROOT):
                disk_files = [
                    f for f in os.listdir(FACES_DATASET_ROOT)
                    if os.path.isfile(os.path.join(FACES_DATASET_ROOT, f))
                    and os.path.splitext(f)[1].lower() in ALLOWED_IMAGE_EXTS
                ]
            ref_count = len(disk_files)
            enrolled_count = ref_count

        return jsonify({
            "success": True,
            "profile_id": "developer",
            "profile_name": profile_name,
            "registered": True,
            "reference_count": ref_count,
            "threshold": threshold,
            "enrolled_count": enrolled_count,
            "opencv_available": (mgr is not None)
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
        refs = []
        if mgr is not None:
            refs = mgr.list_reference_images()
            for r in refs:
                r["url"] = f"/api/dataset/file/faces/{r['filename']}"
        else:
            if os.path.exists(FACES_DATASET_ROOT):
                for f in os.listdir(FACES_DATASET_ROOT):
                    ext = os.path.splitext(f)[1].lower()
                    if ext in ALLOWED_IMAGE_EXTS:
                        f_path = os.path.join(FACES_DATASET_ROOT, f)
                        st = os.stat(f_path)
                        refs.append({
                            "filename": f,
                            "size_bytes": st.st_size,
                            "formatted_size": f"{(st.st_size / 1024):.1f} KB",
                            "mtime": st.st_mtime * 1000,
                            "url": f"/api/dataset/file/faces/{f}"
                        })
            refs.sort(key=lambda x: x.get("mtime", 0), reverse=True)

        return jsonify({"success": True, "references": refs, "count": len(refs)}), 200
    except Exception as e:
        logger.error(f"Error in /api/identity/references: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/identity/register", methods=["POST"])
@require_role("developer")
def identity_register():
    """B6: Register or update developer profile name."""
    try:
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "VisionX Developer").strip()
        mgr = get_identity_manager()
        if mgr is not None:
            res = mgr.register_profile(name)
        else:
            os.makedirs(FACES_DATASET_ROOT, exist_ok=True)
            profile_json = os.path.join(FACES_DATASET_ROOT, "developer_profile.json")
            meta = {"profile_id": "developer", "profile_name": name, "threshold": 0.60}
            with open(profile_json, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2)
            res = meta

        return jsonify({"success": True, "profile": res}), 200
    except Exception as e:
        logger.error(f"Error in /api/identity/register: {e}")
        return jsonify({"success": False, "error": str(e)}), 400


@app.route("/api/identity/add-reference", methods=["POST"])
@require_role("developer")
def identity_add_reference():
    """B6: Enroll new reference image for developer identity."""
    try:
        data = request.get_json(silent=True) or {}
        data_url = data.get("dataUrl")
        filename = data.get("filename")

        if not data_url:
            return jsonify({"success": False, "error": "Parameter dataUrl wajib diberikan."}), 400

        if not filename:
            filename = f"developer_ref_{int(time.time() * 1000)}.jpg"
        filename = sanitize_filename(filename)

        os.makedirs(FACES_DATASET_ROOT, exist_ok=True)
        mgr = get_identity_manager()

        if mgr is not None:
            img = decode_base64_image(data_url)
            res = mgr.add_reference_image(img, filename)
            return jsonify(res), 200
        else:
            # Fallback: OpenCV/cv2 tidak tersedia (Termux mode)
            # Simpan foto referensi fisik ke disk tanpa ekstraksi embedding
            if "," in data_url:
                raw_b64 = data_url.split(",", 1)[1]
            else:
                raw_b64 = data_url
            img_bytes = base64.b64decode(raw_b64)
            save_path = os.path.join(FACES_DATASET_ROOT, filename)
            assert_safe_path(save_path, STORAGE_BASE_DIR)
            with open(save_path, "wb") as f_out:
                f_out.write(img_bytes)

            # Hitung jumlah foto referensi yang tersimpan di disk
            ref_count = 0
            if os.path.exists(FACES_DATASET_ROOT):
                ref_count = len([
                    f for f in os.listdir(FACES_DATASET_ROOT)
                    if os.path.isfile(os.path.join(FACES_DATASET_ROOT, f))
                    and os.path.splitext(f)[1].lower() in ALLOWED_IMAGE_EXTS
                ])

            return jsonify({
                "success": True,
                "filename": filename,
                "saved": True,
                "enrolled": True,
                "message": "Foto tersimpan di disk (Mode fallback: OpenCV offline di Termux)",
                "embedding_status": "offline_fallback",
                "reference_count": ref_count
            }), 200
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
        data = request.get_json(silent=True) or {}
        raw_fname = data.get("filename")

        if not raw_fname:
            return jsonify({"success": False, "error": "Parameter filename wajib diberikan."}), 400

        fname = sanitize_filename(raw_fname)
        mgr = get_identity_manager()
        if mgr is not None:
            ok = mgr.delete_reference_image(fname)
        else:
            target_path = os.path.join(FACES_DATASET_ROOT, fname)
            assert_safe_path(target_path, STORAGE_BASE_DIR)
            ok = False
            if os.path.exists(target_path):
                os.remove(target_path)
                ok = True

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

        if mgr is not None:
            img = decode_base64_image(data_url)
            res = mgr.detect_faces(img)
            return jsonify(res), 200
        else:
            return jsonify({
                "success": False,
                "error": "Modul OpenCV belum terpasang di backend Termux. Deteksi wajah lokal berjalan via ONNX di browser.",
                "faces": []
            }), 200
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

        if mgr is not None:
            img = decode_base64_image(data_url)
            res = mgr.match_face(img, threshold=float(thresh))
            return jsonify({"success": True, **res}), 200
        else:
            return jsonify({
                "success": False,
                "error": "Modul OpenCV belum terpasang di backend Termux. Pengenalan identitas berjalan via ONNX di browser.",
                "matched": False
            }), 200
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
