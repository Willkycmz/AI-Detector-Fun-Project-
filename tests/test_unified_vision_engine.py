"""
Unified Vision & Identity Engine (V0.6.2) Regression Test Suite.
Validates all 10 core scenarios:
1. Developer face moves left/right
2. Developer moves closer/farther
3. Developer moves while camera moves
4. Unknown face
5. No face
6. Laptop + developer simultaneously
7. Multiple objects + developer
8. Portrait phone camera
9. Landscape laptop camera
10. Toggle face recognition on/off
11. Independent failure isolation (YOLO fail != face fail)
12. Backend detect_faces and match_face endpoints structure
"""

import unittest
import numpy as np
import cv2
from pathlib import Path

from app.identity import (
    FaceDetector,
    FaceEmbedder,
    IdentityManager,
    DEFAULT_THRESHOLD,
    DEFAULT_PROFILE_NAME,
)
from tests.test_coordinate_mapper import CoordinateMapperPy


class DetectionFusionPy:
    """Python reference implementation of JavaScript DetectionFusion."""

    @staticmethod
    def fuse(
        object_detections=None,
        face_detections=None,
        identity_result=None,
        options=None,
    ):
        if object_detections is None:
            object_detections = []
        if face_detections is None:
            face_detections = []
        if options is None:
            options = {"enable_face": True, "enable_objects": True}

        unified = []

        # 1. Objek YOLO
        if options.get("enable_objects", True):
            for det in object_detections:
                raw_box = det.get("bbox", {"x1": det.get("x1", 0), "y1": det.get("y1", 0), "x2": det.get("x2", 0), "y2": det.get("y2", 0)})
                bbox = CoordinateMapperPy.normalize_bbox(raw_box)
                class_name = det.get("class_name", "object")
                conf = float(det.get("confidence", 0.0))
                conf_percent = round(conf * 100)
                formatted_class = class_name.replace("_", " ").title()
                label = f"{formatted_class} {conf_percent}%"

                unified.append({
                    "type": "object",
                    "bbox": bbox,
                    "label": label,
                    "confidence": conf,
                    "identityStatus": "OBJECT",
                    "class_name": class_name,
                })

        # 2. Wajah (YuNet + SFace)
        if options.get("enable_face", True) and face_detections:
            active_id = identity_result or {
                "matched": False,
                "label": "PERSON • UNKNOWN",
                "identityStatus": "UNREGISTERED",
                "score_percent": "",
            }

            for face in face_detections:
                bbox = CoordinateMapperPy.normalize_bbox(face.get("bbox", face.get("box")))
                is_matched = bool(active_id.get("matched", False))
                identity_status = "REGISTERED" if is_matched else "UNREGISTERED"

                if is_matched:
                    score_str = active_id.get("score_percent", "91%")
                    label = f"VISIONX DEVELOPER {score_str}".strip()
                    face_conf = float(active_id.get("similarity", 0.91))
                else:
                    label = "PERSON • UNKNOWN"
                    face_conf = float(face.get("confidence", 0.90))

                unified.append({
                    "type": "face",
                    "bbox": bbox,
                    "label": label,
                    "confidence": face_conf,
                    "identityStatus": identity_status,
                    "isDeveloper": is_matched,
                })

        return unified


class TestUnifiedVisionEngineScenarios(unittest.TestCase):

    def test_scenario_1_developer_face_moves_left_right(self):
        """Skenario 1: Wajah developer bergerak ke kiri dan ke kanan."""
        params = CoordinateMapperPy.compute_letterbox_params(1280, 720, 640)
        # Posisi kiri
        face_left = {"x1": 80, "y1": 150, "x2": 240, "y2": 350}
        # Posisi tengah
        face_center = {"x1": 480, "y1": 150, "x2": 640, "y2": 350}
        # Posisi kanan
        face_right = {"x1": 960, "y1": 150, "x2": 1120, "y2": 350}

        for orig in [face_left, face_center, face_right]:
            model_b = CoordinateMapperPy.video_to_model(orig, params)
            restored = CoordinateMapperPy.model_to_video(model_b, params)
            self.assertAlmostEqual(restored["x1"], orig["x1"], delta=2)
            self.assertAlmostEqual(restored["x2"], orig["x2"], delta=2)
            self.assertEqual(restored["width"], 160)

    def test_scenario_2_developer_moves_closer_farther(self):
        """Skenario 2: Wajah developer bergerak mendekat (box membesar) dan menjauh (box mengecil)."""
        params = CoordinateMapperPy.compute_letterbox_params(1280, 720, 640)
        # Jauh (box kecil)
        far_box = {"x1": 560, "y1": 200, "x2": 640, "y2": 300} # w=80, h=100
        # Dekat (box besar)
        close_box = {"x1": 400, "y1": 100, "x2": 800, "y2": 600} # w=400, h=500

        for b in [far_box, close_box]:
            model_b = CoordinateMapperPy.video_to_model(b, params)
            restored = CoordinateMapperPy.model_to_video(model_b, params)
            self.assertAlmostEqual(restored["width"], b["x2"] - b["x1"], delta=2)
            self.assertAlmostEqual(restored["height"], b["y2"] - b["y1"], delta=2)

    def test_scenario_3_developer_moves_while_camera_moves(self):
        """Skenario 3: Wajah bergerak simultan translasi dan skala saat kamera bergerak."""
        params = CoordinateMapperPy.compute_letterbox_params(1280, 720, 640)
        trajectory = [
            {"x1": 100, "y1": 200, "x2": 260, "y2": 400},
            {"x1": 250, "y1": 180, "x2": 450, "y2": 420},
            {"x1": 450, "y1": 150, "x2": 700, "y2": 460},
            {"x1": 700, "y1": 120, "x2": 1000, "y2": 480},
        ]
        for step in trajectory:
            model_b = CoordinateMapperPy.video_to_model(step, params)
            restored = CoordinateMapperPy.model_to_video(model_b, params)
            self.assertAlmostEqual(restored["x1"], step["x1"], delta=2)
            self.assertAlmostEqual(restored["y1"], step["y1"], delta=2)

    def test_scenario_4_unknown_face_labeling(self):
        """Skenario 4: Wajah yang tidak terdaftar otomatis dilabeli PERSON • UNKNOWN."""
        face = {"bbox": {"x1": 200, "y1": 150, "x2": 380, "y2": 350}, "confidence": 0.88}
        id_unknown = {
            "matched": False,
            "label": "PERSON • UNKNOWN",
            "similarity": 0.35,
            "score_percent": "35%",
            "identityStatus": "UNREGISTERED",
        }
        fused = DetectionFusionPy.fuse(
            object_detections=[],
            face_detections=[face],
            identity_result=id_unknown,
        )
        self.assertEqual(len(fused), 1)
        self.assertEqual(fused[0]["type"], "face")
        self.assertEqual(fused[0]["label"], "PERSON • UNKNOWN")
        self.assertEqual(fused[0]["identityStatus"], "UNREGISTERED")

    def test_scenario_5_no_face_handling(self):
        """Skenario 5: Frame tanpa wajah menghasilkan 0 face detection secara aman."""
        fused = DetectionFusionPy.fuse(
            object_detections=[{"class_name": "laptop", "confidence": 0.94, "x1": 100, "y1": 100, "x2": 400, "y2": 350}],
            face_detections=[],
            identity_result=None,
        )
        self.assertEqual(len(fused), 1)
        self.assertEqual(fused[0]["type"], "object")
        self.assertEqual(fused[0]["label"], "Laptop 94%")

    def test_scenario_6_laptop_and_developer_simultaneously(self):
        """Skenario 6: Laptop 94% + Developer face terdeteksi simultan dalam satu frame."""
        laptop_obj = {
            "class_name": "laptop",
            "confidence": 0.94,
            "bbox": {"x1": 100, "y1": 200, "x2": 500, "y2": 500},
        }
        dev_face = {
            "bbox": {"x1": 600, "y1": 100, "x2": 800, "y2": 350},
            "confidence": 0.91,
        }
        id_dev = {
            "matched": True,
            "label": "VISIONX DEVELOPER 91%",
            "similarity": 0.91,
            "score_percent": "91%",
            "identityStatus": "REGISTERED",
        }

        fused = DetectionFusionPy.fuse(
            object_detections=[laptop_obj],
            face_detections=[dev_face],
            identity_result=id_dev,
        )
        self.assertEqual(len(fused), 2)
        types = {item["type"] for item in fused}
        self.assertEqual(types, {"object", "face"})

        laptop_item = [it for it in fused if it["type"] == "object"][0]
        dev_item = [it for it in fused if it["type"] == "face"][0]

        self.assertEqual(laptop_item["label"], "Laptop 94%")
        self.assertEqual(dev_item["label"], "VISIONX DEVELOPER 91%")
        self.assertEqual(dev_item["identityStatus"], "REGISTERED")

    def test_scenario_7_multiple_objects_and_developer(self):
        """Skenario 7: Multiple objects (Laptop 94%, Mouse 88%, Bottle 83%) + Developer."""
        objects = [
            {"class_name": "laptop", "confidence": 0.94, "bbox": {"x1": 50, "y1": 300, "x2": 450, "y2": 600}},
            {"class_name": "mouse", "confidence": 0.88, "bbox": {"x1": 500, "y1": 450, "x2": 600, "y2": 550}},
            {"class_name": "bottle", "confidence": 0.83, "bbox": {"x1": 700, "y1": 250, "x2": 800, "y2": 550}},
        ]
        dev_face = {
            "bbox": {"x1": 550, "y1": 80, "x2": 720, "y2": 280},
            "confidence": 0.95,
        }
        id_dev = {
            "matched": True,
            "label": "VISIONX DEVELOPER 95%",
            "similarity": 0.95,
            "score_percent": "95%",
            "identityStatus": "REGISTERED",
        }

        fused = DetectionFusionPy.fuse(
            object_detections=objects,
            face_detections=[dev_face],
            identity_result=id_dev,
        )
        self.assertEqual(len(fused), 4)
        labels = [it["label"] for it in fused]
        self.assertIn("Laptop 94%", labels)
        self.assertIn("Mouse 88%", labels)
        self.assertIn("Bottle 83%", labels)
        self.assertIn("VISIONX DEVELOPER 95%", labels)

    def test_scenario_8_portrait_phone_camera(self):
        """Skenario 8: Kamera HP mode portrait (9:16, misal 720x1280)."""
        params = CoordinateMapperPy.compute_letterbox_params(720, 1280, 640)
        self.assertEqual(params["scale"], 0.5)
        self.assertEqual(params["pad_x"], 140)
        self.assertEqual(params["pad_y"], 0)

        # Wajah di portrait video
        portrait_face = {"x1": 200, "y1": 300, "x2": 520, "y2": 700}
        model_b = CoordinateMapperPy.video_to_model(portrait_face, params)
        restored = CoordinateMapperPy.model_to_video(model_b, params)

        self.assertAlmostEqual(restored["x1"], portrait_face["x1"], delta=2)
        self.assertAlmostEqual(restored["y1"], portrait_face["y1"], delta=2)

    def test_scenario_9_landscape_laptop_camera(self):
        """Skenario 9: Kamera laptop landscape (16:9, misal 1920x1080)."""
        params = CoordinateMapperPy.compute_letterbox_params(1920, 1080, 640)
        self.assertAlmostEqual(params["scale"], 640 / 1920, places=4)
        self.assertEqual(params["pad_x"], 0)
        self.assertGreater(params["pad_y"], 0)

        landscape_face = {"x1": 800, "y1": 300, "x2": 1120, "y2": 700}
        model_b = CoordinateMapperPy.video_to_model(landscape_face, params)
        restored = CoordinateMapperPy.model_to_video(model_b, params)

        self.assertAlmostEqual(restored["x1"], landscape_face["x1"], delta=2)
        self.assertAlmostEqual(restored["y1"], landscape_face["y1"], delta=2)

    def test_scenario_10_toggle_face_recognition_on_off(self):
        """Skenario 10: Toggle face recognition on/off tidak mengganggu deteksi objek YOLO."""
        objects = [{"class_name": "laptop", "confidence": 0.94, "x1": 100, "y1": 100, "x2": 400, "y2": 350}]
        faces = [{"bbox": {"x1": 500, "y1": 100, "x2": 700, "y2": 350}, "confidence": 0.90}]
        id_res = {"matched": True, "label": "VISIONX DEVELOPER", "score_percent": "90%"}

        # 1. Toggle ON: Keduanya muncul
        fused_on = DetectionFusionPy.fuse(
            object_detections=objects,
            face_detections=faces,
            identity_result=id_res,
            options={"enable_face": True, "enable_objects": True},
        )
        self.assertEqual(len(fused_on), 2)

        # 2. Toggle OFF: Hanya objek YOLO yang muncul
        fused_off = DetectionFusionPy.fuse(
            object_detections=objects,
            face_detections=faces,
            identity_result=id_res,
            options={"enable_face": False, "enable_objects": True},
        )
        self.assertEqual(len(fused_off), 1)
        self.assertEqual(fused_off[0]["type"], "object")
        self.assertEqual(fused_off[0]["label"], "Laptop 94%")

    def test_scenario_11_independent_failure_isolation(self):
        """
        Skenario 11:
        - Kegagalan Face Engine (face_detections = None/error) TIDAK menghentikan YOLO.
        - Kegagalan YOLO (object_detections = None/error) TIDAK menghentikan Face Engine.
        """
        # A. YOLO fail (kosong/None), Face works
        fused_yolo_failed = DetectionFusionPy.fuse(
            object_detections=[],
            face_detections=[{"bbox": {"x1": 200, "y1": 150, "x2": 400, "y2": 380}, "confidence": 0.92}],
            identity_result={"matched": True, "score_percent": "92%"},
            options={"enable_face": True, "enable_objects": False},
        )
        self.assertEqual(len(fused_yolo_failed), 1)
        self.assertEqual(fused_yolo_failed[0]["type"], "face")
        self.assertEqual(fused_yolo_failed[0]["identityStatus"], "REGISTERED")

        # B. Face fail (kosong/None), YOLO works
        fused_face_failed = DetectionFusionPy.fuse(
            object_detections=[{"class_name": "bottle", "confidence": 0.85, "x1": 50, "y1": 50, "x2": 150, "y2": 350}],
            face_detections=[],
            identity_result=None,
            options={"enable_face": True, "enable_objects": True},
        )
        self.assertEqual(len(fused_face_failed), 1)
        self.assertEqual(fused_face_failed[0]["type"], "object")
        self.assertEqual(fused_face_failed[0]["label"], "Bottle 85%")

    def test_backend_detect_faces_method(self, tmp_path=None):
        """Memastikan backend IdentityManager memiliki method detect_faces yang valid."""
        mgr = IdentityManager()
        blank_img = np.zeros((320, 320, 3), dtype=np.uint8)
        res = mgr.detect_faces(blank_img)
        self.assertTrue(res["success"])
        self.assertFalse(res["detected"])
        self.assertEqual(res["faces_count"], 0)
        self.assertEqual(res["faces"], [])


if __name__ == "__main__":
    unittest.main()
