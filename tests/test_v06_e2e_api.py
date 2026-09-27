import urllib.request
import urllib.error
import json
import base64
import numpy as np
import cv2
import pytest
from pathlib import Path

BASE_URL = "http://localhost:5173"

def make_req(path, data=None, method=None):
    url = f"{BASE_URL}{path}"
    headers = {"Content-Type": "application/json"}
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode("utf-8")
            return resp.status, json.loads(content)
    except urllib.error.HTTPError as e:
        content = e.read().decode("utf-8")
        try:
            return e.code, json.loads(content)
        except Exception:
            return e.code, {"raw": content}

class TestDatasetManagerEndpoints:
    def test_manager_stats_and_list(self):
        status, stats = make_req("/api/manager/stats")
        assert status == 200
        assert stats["success"] is True
        assert "totalImages" in stats
        assert "trashCount" in stats

        status, items = make_req("/api/manager/list")
        assert status == 200
        assert items["success"] is True
        assert "items" in items
        assert isinstance(items["items"], list)

    def test_manager_trash_and_restore_flow(self):
        # 1. Create a dummy test image to manipulate safely
        dummy_img = np.zeros((100, 100, 3), dtype=np.uint8)
        _, enc = cv2.imencode(".jpg", dummy_img)
        b64_data = f"data:image/jpeg;base64,{base64.b64encode(enc.tobytes()).decode('ascii')}"

        import_payload = {
            "files": [{
                "filename": "e2e_manager_test.jpg",
                "className": "earphone",
                "source": "own_capture",
                "dataUrl": b64_data
            }]
        }
        status, imp_res = make_req("/api/manager/import", data=import_payload, method="POST")
        assert status == 200
        assert imp_res["count"] >= 1
        test_filename = imp_res["items"][0]["filename"]

        # 2. Soft delete / move to trash
        status, trash_res = make_req("/api/manager/trash", data={
            "items": [{
                "id": test_filename,
                "filename": test_filename,
                "className": "earphone",
                "source": "own_capture"
            }]
        }, method="POST")
        assert status == 200
        assert trash_res["success"] is True
        assert trash_res["count"] == 1

        # 3. Verify in trash list
        status, trash_list = make_req("/api/manager/list?view=trash")
        assert status == 200
        trashed_items = trash_list["items"]
        matching_trash = [it for it in trashed_items if test_filename in it["filename"]]
        assert len(matching_trash) > 0
        trashed_item = matching_trash[0]

        # 4. Restore the item
        status, restore_res = make_req("/api/manager/restore", data={
            "items": [trashed_item]
        }, method="POST")
        assert status == 200
        assert restore_res["success"] is True
        assert restore_res["count"] == 1

        # 5. Verify back in active list
        status, active_list = make_req("/api/manager/list")
        assert status == 200
        active_ids = [it["filename"] for it in active_list["items"]]
        assert test_filename in active_ids

        # 6. Clean up: move to trash then permanent delete
        make_req("/api/manager/trash", data={
            "items": [{
                "id": test_filename,
                "filename": test_filename,
                "className": "earphone",
                "source": "own_capture"
            }]
        }, method="POST")
        status, trash_list2 = make_req("/api/manager/list?view=trash")
        matching_clean = [it for it in trash_list2["items"] if test_filename in it["filename"]][0]
        status, perm_res = make_req("/api/manager/delete-permanent", data={
            "items": [matching_clean]
        }, method="POST")
        assert status == 200
        assert perm_res["count"] == 1

    def test_manager_path_traversal_safety(self):
        # Attempt path traversal in delete-permanent
        traversal_attempts = [
            {"filename": "../../secret.txt", "className": "earphone", "source": "own"},
            {"trashFilename": "../../windows/system32/cmd.exe", "fromTrash": True}
        ]
        status, res = make_req("/api/manager/delete-permanent", data={"items": traversal_attempts}, method="POST")
        # Must either reject with 403 or safely return count: 0
        if status == 200:
            assert res.get("count", 0) == 0
        else:
            assert status in (400, 403, 500)

class TestIdentityLabEndpoints:
    def test_identity_profile(self):
        status, profile = make_req("/api/identity/profile")
        assert status == 200
        assert profile["success"] is True
        assert profile["profile_name"] == "VisionX Developer"
        assert profile["profile_id"] == "developer"

    def test_identity_references_list(self):
        status, refs = make_req("/api/identity/references")
        assert status == 200
        assert refs["success"] is True
        assert "references" in refs

    def test_identity_match_without_faces(self):
        # Image with non-face pattern
        img = np.full((300, 300, 3), 120, dtype=np.uint8)
        _, enc = cv2.imencode(".jpg", img)
        b64_data = f"data:image/jpeg;base64,{base64.b64encode(enc.tobytes()).decode('ascii')}"

        status, match_res = make_req("/api/identity/match", data={"dataUrl": b64_data, "threshold": 0.6}, method="POST")
        assert status == 200
        assert match_res["success"] is True
        assert match_res["primary_match"]["matched"] is False

    def test_identity_live_enroll_match_and_delete_flow(self):
        # Find a real sample image with faces
        processed_dir = Path("datasets/processed/images/train")
        from app.identity import FaceDetector
        detector = FaceDetector()

        found = None
        for p in processed_dir.glob("*.jpg"):
            img = cv2.imread(str(p))
            if img is not None:
                faces = detector.detect(img)
                if len(faces) >= 2:
                    found = (img, faces)
                    break

        if not found:
            pytest.skip("No sample image with faces found")

        img, faces = found
        from app.identity import FaceEmbedder
        embedder = FaceEmbedder()
        recognizer = cv2.FaceRecognizerSF.create(str(embedder.model_path), "")

        # Crop face 0 (Developer reference)
        face0 = recognizer.alignCrop(img, faces[0])
        _, enc0 = cv2.imencode(".jpg", face0)
        b64_face0 = f"data:image/jpeg;base64,{base64.b64encode(enc0.tobytes()).decode('ascii')}"

        # Crop face 1 (Unknown person)
        face1 = recognizer.alignCrop(img, faces[1])
        _, enc1 = cv2.imencode(".jpg", face1)
        b64_face1 = f"data:image/jpeg;base64,{base64.b64encode(enc1.tobytes()).decode('ascii')}"

        # 1. Enroll face 0 via API
        status, add_res = make_req("/api/identity/add-reference", data={
            "dataUrl": b64_face0,
            "filename": "e2e_dev_ref.jpg"
        }, method="POST")
        assert status == 200
        assert add_res["success"] is True

        # 2. Check reference list
        status, refs_res = make_req("/api/identity/references")
        assert status == 200
        ref_names = [r["filename"] for r in refs_res["references"]]
        assert "e2e_dev_ref.jpg" in ref_names

        # 3. Match face 0 -> Must identify as "VISIONX DEVELOPER"
        status, match_dev = make_req("/api/identity/match", data={
            "dataUrl": b64_face0,
            "threshold": 0.60
        }, method="POST")
        assert status == 200
        assert match_dev["success"] is True
        assert match_dev["primary_match"]["matched"] is True
        assert match_dev["primary_match"]["label"] == "VISIONX DEVELOPER"
        assert match_dev["primary_match"]["similarity"] >= 0.70

        # 4. Match face 1 (different person) -> Must identify as "PERSON • UNKNOWN"
        status, match_unk = make_req("/api/identity/match", data={
            "dataUrl": b64_face1,
            "threshold": 0.60
        }, method="POST")
        assert status == 200
        assert match_unk["success"] is True
        assert match_unk["primary_match"]["matched"] is False
        assert match_unk["primary_match"]["label"] == "PERSON • UNKNOWN"

        # 5. Delete enrolled reference
        status, del_res = make_req("/api/identity/delete-reference", data={
            "filename": "e2e_dev_ref.jpg"
        }, method="POST")
        assert status == 200
        assert del_res["success"] is True
        assert del_res["deleted"] is True

        # 6. Verify reference list is now empty
        status, refs_after = make_req("/api/identity/references")
        assert status == 200
        ref_names_after = [r["filename"] for r in refs_after["references"]]
        assert "e2e_dev_ref.jpg" not in ref_names_after


    def test_identity_delete_invalid_reference(self):
        # Attempt to delete non-existent or path traversal reference
        status, res = make_req("/api/identity/delete-reference", data={"filename": "../../../important.txt"}, method="POST")
        assert status == 200
        assert res["success"] is True
        assert res["deleted"] is False
