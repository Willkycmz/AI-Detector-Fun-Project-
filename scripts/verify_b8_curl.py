"""
Verification script executing real curl commands against running VisionX server.
Demonstrates B8 verification criteria 1 - 6.
"""

import os
import sys
import time
import json
import subprocess
import jwt

# Configuration matching test expectations
TEST_PORT = 5055
TEST_SECRET = "test-supabase-jwt-secret-key-32bytes-ok!"
os.environ["PORT"] = str(TEST_PORT)
os.environ["SUPABASE_JWT_SECRET"] = TEST_SECRET
os.environ["SUPABASE_URL"] = "https://wnwaniiuflsuemyambuy.supabase.co"
os.environ["SUPABASE_AUDIENCE"] = "authenticated"
os.environ["VISIONX_ADMIN_PIN"] = "visionx2026"
os.environ["VISIONX_AUTH_SECRET"] = "visionx-auth-secret-key-prod-2026"
os.environ["VISIONX_LEGACY_PIN"] = "1"

# Generate Tokens
now = int(time.time())

# Token 1: Role User
user_payload = {
    "sub": "user_normal_01",
    "aud": "authenticated",
    "iss": "https://wnwaniiuflsuemyambuy.supabase.co/auth/v1",
    "iat": now,
    "exp": now + 3600,
    "app_metadata": {"role": "user"}
}
USER_TOKEN = jwt.encode(user_payload, TEST_SECRET, algorithm="HS256")

# Token 2: Role Developer
dev_payload = {
    "sub": "developer_lead_01",
    "aud": "authenticated",
    "iss": "https://wnwaniiuflsuemyambuy.supabase.co/auth/v1",
    "iat": now,
    "exp": now + 3600,
    "app_metadata": {"role": "developer"}
}
DEV_TOKEN = jwt.encode(dev_payload, TEST_SECRET, algorithm="HS256")

# Token 3: Expired Token
expired_payload = {
    "sub": "developer_expired_01",
    "aud": "authenticated",
    "iss": "https://wnwaniiuflsuemyambuy.supabase.co/auth/v1",
    "iat": now - 7200,
    "exp": now - 3600,
    "app_metadata": {"role": "developer"}
}
EXPIRED_TOKEN = jwt.encode(expired_payload, TEST_SECRET, algorithm="HS256")


def run_curl(desc: str, cmd_args: list):
    print(f"\n{'='*70}")
    print(f"TEST: {desc}")
    full_cmd = ["curl.exe", "-s", "-w", "\nHTTP_STATUS:%{http_code}\n"] + cmd_args
    print(f"COMMAND: {' '.join(full_cmd)}")
    print(f"{'-'*70}")
    result = subprocess.run(full_cmd, capture_output=True, text=True)
    output = result.stdout.strip()
    status = "UNKNOWN"
    body = output
    if "HTTP_STATUS:" in output:
        parts = output.split("HTTP_STATUS:")
        body = parts[0].strip()
        status = parts[1].strip()
    print(f"RESPONSE STATUS: {status}")
    print(f"RESPONSE BODY  : {body}")
    return status, body


def main():
    print(f"Starting VisionX test server on port {TEST_PORT}...")
    server_proc = subprocess.Popen(
        [sys.executable, "server.py"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    time.sleep(2.5)  # Wait for server to boot

    try:
        # Case 1: Request without token -> 401 Unauthorized
        run_curl(
            "1. Request tanpa token (Endpoint Developer: /api/manager/stats)",
            [f"http://127.0.0.1:{TEST_PORT}/api/manager/stats"]
        )

        # Case 2: Token role 'user' accessing developer endpoint -> 403 Forbidden
        run_curl(
            "2. Token role 'user' mengakses endpoint developer (/api/manager/stats)",
            [
                "-H", f"Authorization: Bearer {USER_TOKEN}",
                f"http://127.0.0.1:{TEST_PORT}/api/manager/stats"
            ]
        )

        # Case 3: Token role 'developer' accessing developer endpoint -> 200 OK
        run_curl(
            "3. Token role 'developer' mengakses endpoint developer (/api/manager/stats)",
            [
                "-H", f"Authorization: Bearer {DEV_TOKEN}",
                f"http://127.0.0.1:{TEST_PORT}/api/manager/stats"
            ]
        )

        # Case 4: Token expired -> 401 Unauthorized
        run_curl(
            "4. Token expired mengakses endpoint developer (/api/manager/stats)",
            [
                "-H", f"Authorization: Bearer {EXPIRED_TOKEN}",
                f"http://127.0.0.1:{TEST_PORT}/api/manager/stats"
            ]
        )

        # Case 5: Legacy PIN login and request -> 200 OK
        print(f"\n{'='*70}")
        print("TEST: 5a. Login dengan PIN lama (/api/login)")
        login_res = subprocess.run(
            [
                "curl.exe", "-s", "-X", "POST",
                "-H", "Content-Type: application/json",
                "-d", "{\"pin\":\"visionx2026\"}",
                f"http://127.0.0.1:{TEST_PORT}/api/login"
            ],
            capture_output=True,
            text=True
        )
        login_json = json.loads(login_res.stdout)
        legacy_token = login_json.get("token")
        print(f"LEGACY TOKEN OBTAINED: {legacy_token[:30]}... (role: {login_json.get('role')})")

        run_curl(
            "5b. Request dengan legacy PIN token (ketika VISIONX_LEGACY_PIN=1)",
            [
                "-H", f"Authorization: Bearer {legacy_token}",
                f"http://127.0.0.1:{TEST_PORT}/api/manager/stats"
            ]
        )

        # Case 6: Directory Traversal attempt -> 400 Bad Request
        run_curl(
            "6. Percobaan path traversal ('../../etc/passwd.jpg') pada /api/dataset/save",
            [
                "-X", "POST",
                "-H", f"Authorization: Bearer {DEV_TOKEN}",
                "-H", "Content-Type: application/json",
                "-d", json.dumps({
                    "filename": "../../etc/passwd.jpg",
                    "className": "traversal_test",
                    "source": "own_capture",
                    "dataUrl": "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
                }),
                f"http://127.0.0.1:{TEST_PORT}/api/dataset/save"
            ]
        )

    finally:
        print(f"\n{'='*70}")
        print("Stopping test server...")
        server_proc.terminate()
        server_proc.wait()
        print("Test server stopped successfully.")


if __name__ == "__main__":
    main()
