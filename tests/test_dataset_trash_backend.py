"""
Test dataset trash, restore, permanent delete, and image serving endpoints in server.py.
"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import unittest
import server
from server import app, generate_token, RAW_DATASET_ROOT, TRASH_DATASET_ROOT


class TestDatasetTrashBackend(unittest.TestCase):
    def setUp(self):
        server.VISIONX_LEGACY_PIN = True
        self.client = app.test_client()
        self.token = generate_token(subject="dev_test", expires_in_sec=3600)
        self.headers = {"Authorization": f"Bearer {self.token}"}

        # Setup test file
        self.test_class_dir = os.path.join(RAW_DATASET_ROOT, "own", "test_trash_class")
        os.makedirs(self.test_class_dir, exist_ok=True)
        self.test_filename = "backend_trash_test.png"
        self.test_filepath = os.path.join(self.test_class_dir, self.test_filename)
        with open(self.test_filepath, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82")

    def tearDown(self):
        # Clean up any leftover test files
        if os.path.exists(self.test_filepath):
            try: os.remove(self.test_filepath)
            except Exception: pass
        trash_file = os.path.join(TRASH_DATASET_ROOT, self.test_filename)
        if os.path.exists(trash_file):
            try: os.remove(trash_file)
            except Exception: pass

    def test_dataset_trash_workflow(self):
        # 1. Test GET /api/dataset/list (Active)
        res = self.client.get("/api/dataset/list?view=active", headers=self.headers)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("success"))
        self.assertIn("active_count", data)
        self.assertIn("trash_count", data)

        active_fnames = [it["filename"] for it in data.get("items", [])]
        self.assertIn(self.test_filename, active_fnames)

        # 2. Test GET /api/dataset/image/<path>
        img_res = self.client.get(f"/api/dataset/image/own/test_trash_class/{self.test_filename}")
        self.assertEqual(img_res.status_code, 200)
        self.assertEqual(img_res.mimetype, "image/png")
        img_res.close()

        # 3. Test POST /api/dataset/trash
        trash_res = self.client.post("/api/dataset/trash", json={"filenames": [self.test_filename]}, headers=self.headers)
        self.assertEqual(trash_res.status_code, 200)
        trash_data = trash_res.get_json()
        self.assertTrue(trash_data.get("success"))
        self.assertIn(self.test_filename, trash_data.get("moved", []))

        # Verify physical move on disk
        self.assertFalse(os.path.exists(self.test_filepath))
        trash_path = os.path.join(TRASH_DATASET_ROOT, self.test_filename)
        self.assertTrue(os.path.exists(trash_path))

        # 4. Test GET /api/dataset/list (Trash View)
        trash_list_res = self.client.get("/api/dataset/list?view=trash", headers=self.headers)
        self.assertEqual(trash_list_res.status_code, 200)
        trash_items = trash_list_res.get_json().get("items", [])
        trash_fnames = [it["filename"] for it in trash_items]
        self.assertIn(self.test_filename, trash_fnames)

        # 5. Test POST /api/dataset/restore
        restore_res = self.client.post("/api/dataset/restore", json={"filenames": [self.test_filename]}, headers=self.headers)
        self.assertEqual(restore_res.status_code, 200)
        restore_data = restore_res.get_json()
        self.assertTrue(restore_data.get("success"))
        self.assertIn(self.test_filename, restore_data.get("restored", []))

        # Verify physical restore on disk
        self.assertTrue(os.path.exists(self.test_filepath))
        self.assertFalse(os.path.exists(trash_path))

        # 6. Move back to trash, then permanent delete
        self.client.post("/api/dataset/trash", json={"filenames": [self.test_filename]}, headers=self.headers)
        self.assertTrue(os.path.exists(trash_path))

        perm_res = self.client.delete("/api/dataset/permanent", json={"filenames": [self.test_filename]}, headers=self.headers)
        self.assertEqual(perm_res.status_code, 200)
        perm_data = perm_res.get_json()
        self.assertTrue(perm_data.get("success"))
        self.assertIn(self.test_filename, perm_data.get("deleted", []))

        # Verify physical deletion
        self.assertFalse(os.path.exists(trash_path))
        self.assertFalse(os.path.exists(self.test_filepath))


if __name__ == "__main__":
    unittest.main()
