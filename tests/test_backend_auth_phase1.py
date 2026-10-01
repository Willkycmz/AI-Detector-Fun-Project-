"""
VisionX Phase 1 Backend Authentication & Developer Role Test Suite
===================================================================
Validates all requirements B1 - B8:
1. Request without token -> 401 Unauthorized
2. Token role "user" accessing developer endpoint -> 403 Forbidden
3. Token role "developer" accessing developer endpoint -> 200 OK
4. Token expired -> 401 Unauthorized
5. Request with legacy PIN token (when VISIONX_LEGACY_PIN=1) -> 200 OK
6. Path traversal attempt (e.g. '../') -> rejected with 400 Bad Request
7. Chat rate limit: user capped at daily limit (429), developer unlimited
"""

import os
import sys
import time
import json
import pytest
import jwt

# Configure test environment variables BEFORE importing server
TEST_JWT_SECRET = "test-supabase-jwt-secret-key-32bytes-ok!"
os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
os.environ["SUPABASE_URL"] = "https://wnwaniiuflsuemyambuy.supabase.co"
os.environ["SUPABASE_AUDIENCE"] = "authenticated"
os.environ["VISIONX_ADMIN_PIN"] = "visionx2026"
os.environ["VISIONX_AUTH_SECRET"] = "visionx-auth-secret-key-prod-2026"
os.environ["VISIONX_LEGACY_PIN"] = "1"
os.environ["VISIONX_USER_DAILY_CHAT_LIMIT"] = "3"  # Small limit for testing

from server import app, generate_token, user_daily_chat_tracker


@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def make_supabase_token(role="user", user_id="test_user_01", expired=False, tamper_user_metadata_role=None):
    """Helper to generate Supabase JWT tokens for testing."""
    now = int(time.time())
    payload = {
        "sub": user_id,
        "aud": "authenticated",
        "iss": "https://wnwaniiuflsuemyambuy.supabase.co/auth/v1",
        "iat": now - 100,
        "exp": now - 50 if expired else now + 3600,
        "email": f"{user_id}@example.com",
        "app_metadata": {
            "role": role
        }
    }
    if tamper_user_metadata_role:
        # User tries to tamper with user_metadata to gain privileges
        payload["user_metadata"] = {"role": tamper_user_metadata_role}

    return jwt.encode(payload, TEST_JWT_SECRET, algorithm="HS256")


# -----------------------------------------------------------------------------
# Test 1: Request without token -> 401 Unauthorized
# -----------------------------------------------------------------------------
def test_1_request_without_token_returns_401(client):
    """B8.1: Request without token must return 401 Unauthorized."""
    resp = client.get("/api/manager/stats")
    assert resp.status_code == 401
    data = resp.get_json()
    assert "error" in data
    assert "Missing Authorization" in data["error"] or "Authorization" in data["error"]


# -----------------------------------------------------------------------------
# Test 2: Token role 'user' accessing developer endpoint -> 403 Forbidden
# -----------------------------------------------------------------------------
def test_2_token_user_role_accessing_developer_endpoint_returns_403(client):
    """B8.2: Token with role 'user' accessing developer endpoint must return 403 Forbidden."""
    token = make_supabase_token(role="user", user_id="regular_user_1")
    resp = client.get("/api/manager/stats", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
    data = resp.get_json()
    assert "Forbidden" in data["error"]
    assert data.get("current_role") == "user"


def test_2b_tampered_user_metadata_role_is_ignored(client):
    """B2: Role MUST come from app_metadata.user, NOT user_metadata."""
    # User attempts to inject role="developer" into user_metadata while app_metadata is "user"
    token = make_supabase_token(role="user", user_id="sneaky_user", tamper_user_metadata_role="developer")
    resp = client.get("/api/manager/stats", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
    data = resp.get_json()
    assert "Forbidden" in data["error"]
    assert data.get("current_role") == "user"


# -----------------------------------------------------------------------------
# Test 3: Token role 'developer' accessing developer endpoint -> 200 OK
# -----------------------------------------------------------------------------
def test_3_token_developer_role_accessing_developer_endpoint_returns_200(client):
    """B8.3: Token with role 'developer' accessing developer endpoint must return 200 OK."""
    token = make_supabase_token(role="developer", user_id="lead_dev_1")
    resp = client.get("/api/manager/stats", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"] is True
    assert "totalImages" in data
    assert "formattedTotalSize" in data


# -----------------------------------------------------------------------------
# Test 4: Token expired -> 401 Unauthorized
# -----------------------------------------------------------------------------
def test_4_expired_token_returns_401(client):
    """B8.4: Expired token must return 401 Unauthorized."""
    expired_token = make_supabase_token(role="developer", expired=True)
    resp = client.get("/api/manager/stats", headers={"Authorization": f"Bearer {expired_token}"})
    assert resp.status_code == 401
    data = resp.get_json()
    assert "expired" in data["error"].lower()


# -----------------------------------------------------------------------------
# Test 5: Legacy PIN Token -> 200 OK with developer role
# -----------------------------------------------------------------------------
def test_5_legacy_pin_login_and_access(client):
    """B8.5: Request with legacy PIN token (when VISIONX_LEGACY_PIN=1) must return 200 OK."""
    # Step 1: Login via legacy endpoint with admin PIN
    login_resp = client.post("/api/login", json={"pin": "visionx2026"})
    assert login_resp.status_code == 200
    login_data = login_resp.get_json()
    assert "token" in login_data
    legacy_token = login_data["token"]
    assert login_data.get("role") == "developer"

    # Step 2: Use the legacy token on protected developer endpoint
    stats_resp = client.get("/api/manager/stats", headers={"Authorization": f"Bearer {legacy_token}"})
    assert stats_resp.status_code == 200
    stats_data = stats_resp.get_json()
    assert stats_data["success"] is True


# -----------------------------------------------------------------------------
# Test 6: Path Traversal Attempt -> Rejected with 400 Bad Request
# -----------------------------------------------------------------------------
def test_6_path_traversal_attempts_rejected(client):
    """B8.6: Directory traversal attempts (e.g. '../') must be rejected with 400 Bad Request."""
    token = make_supabase_token(role="developer", user_id="lead_dev_1")
    headers = {"Authorization": f"Bearer {token}"}

    # Case A: Path traversal in filename during dataset save
    traversal_payload = {
        "filename": "../../../etc/passwd.jpg",
        "className": "test_class",
        "source": "own_capture",
        "dataUrl": "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    }
    resp1 = client.post("/api/dataset/save", json=traversal_payload, headers=headers)
    assert resp1.status_code == 400
    assert "traversal" in resp1.get_json()["error"].lower()

    # Case B: Path traversal in className during dataset delete
    delete_traversal_payload = {
        "filename": "sample.jpg",
        "className": "../../../secret_folder",
        "source": "own_capture"
    }
    resp2 = client.post("/api/dataset/delete", json=delete_traversal_payload, headers=headers)
    assert resp2.status_code == 400
    assert "traversal" in resp2.get_json()["error"].lower()

    # Case C: Disallowed non-image file extension (e.g. .py, .exe, .sh)
    disallowed_ext_payload = {
        "filename": "malicious_script.sh",
        "className": "test_class",
        "source": "own_capture",
        "dataUrl": "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    }
    resp3 = client.post("/api/dataset/save", json=disallowed_ext_payload, headers=headers)
    assert resp3.status_code == 400
    assert "extension" in resp3.get_json()["error"].lower()


# -----------------------------------------------------------------------------
# Test 7: Rate Limiting on /api/chat (B5)
# -----------------------------------------------------------------------------
def test_7_user_daily_chat_rate_limiting(client):
    """B5: Standard users are rate limited to daily quota (429), developers are unlimited."""
    user_token = make_supabase_token(role="user", user_id="rate_limited_user")
    headers_user = {"Authorization": f"Bearer {user_token}"}
    chat_payload = {"message": "Halo VisionX"}

    # Reset tracker for clean test
    user_daily_chat_tracker.clear()

    # Quota is set to 3 for tests
    for i in range(3):
        r = client.post("/api/chat", json=chat_payload, headers=headers_user)
        assert r.status_code == 200, f"Attempt {i+1} should succeed"
        _ = r.get_data()  # Consume stream so context closes cleanly

    # 4th request must exceed daily quota and return 429
    r_exceeded = client.post("/api/chat", json=chat_payload, headers=headers_user)
    assert r_exceeded.status_code == 429
    assert "kuota chat harian" in r_exceeded.get_json()["error"]

    # Developer user with same request has NO quota limit
    dev_token = make_supabase_token(role="developer", user_id="unlimited_dev")
    headers_dev = {"Authorization": f"Bearer {dev_token}"}
    for _ in range(5):
        r_dev = client.post("/api/chat", json=chat_payload, headers=headers_dev)
        assert r_dev.status_code == 200
        _ = r_dev.get_data()


# -----------------------------------------------------------------------------
# Test 8: CORS Configuration (B7)
# -----------------------------------------------------------------------------
def test_8_cors_headers_production_and_local(client):
    """B7: Verify CORS headers allow https://app.visionx.my.id and local dev."""
    prod_resp = client.options(
        "/api/chat",
        headers={
            "Origin": "https://app.visionx.my.id",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization, Content-Type"
        }
    )
    assert prod_resp.status_code in [200, 204]
    assert prod_resp.headers.get("Access-Control-Allow-Origin") == "https://app.visionx.my.id"
    assert "Authorization" in prod_resp.headers.get("Access-Control-Allow-Headers", "")

    local_resp = client.options(
        "/api/manager/stats",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization"
        }
    )
    assert local_resp.status_code in [200, 204]
    assert local_resp.headers.get("Access-Control-Allow-Origin") == "http://localhost:5173"
