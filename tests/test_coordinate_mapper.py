"""
Unit and regression tests for VisionX CoordinateMapper (V0.6.2).
Validates:
- Aspect ratio calculations: 16:9 (landscape), 4:3 (classic), 9:16 (portrait phone)
- Letterbox padding and scale factors
- Forward and inverse mapping (model letterbox <-> video coordinates)
- Mirrored front camera transformations
- Boundary clamping
- Bounding box format normalization
"""

import unittest
import math


class CoordinateMapperPy:
    """Python reference implementation of the JavaScript CoordinateMapper."""

    @staticmethod
    def compute_letterbox_params(src_w: int, src_h: int, target_dim: int = 640):
        w = max(1, src_w)
        h = max(1, src_h)

        scale = min(target_dim / w, target_dim / h)
        nw = round(w * scale)
        nh = round(h * scale)
        pad_x = (target_dim - nw) / 2
        pad_y = (target_dim - nh) / 2

        aspect = w / h
        if abs(aspect - 16 / 9) < 0.1:
            aspect_label = "16:9"
        elif abs(aspect - 4 / 3) < 0.1:
            aspect_label = "4:3"
        elif abs(aspect - 9 / 16) < 0.1:
            aspect_label = "9:16 (Portrait)"
        elif aspect < 1:
            aspect_label = f"Portrait ({aspect:.2f})"
        else:
            aspect_label = f"Landscape ({aspect:.2f})"

        return {
            "scale": scale,
            "pad_x": pad_x,
            "pad_y": pad_y,
            "nw": nw,
            "nh": nh,
            "target_dim": target_dim,
            "src_w": w,
            "src_h": h,
            "aspect_ratio": aspect,
            "aspect_label": aspect_label,
        }

    @staticmethod
    def normalize_bbox(box, is_xywh: bool = False):
        if isinstance(box, (list, tuple)):
            if len(box) >= 4:
                if is_xywh:
                    return {
                        "x1": box[0],
                        "y1": box[1],
                        "x2": box[0] + box[2],
                        "y2": box[1] + box[3],
                    }
                return {"x1": box[0], "y1": box[1], "x2": box[2], "y2": box[3]}
        elif isinstance(box, dict):
            if "x1" in box and "y1" in box and "x2" in box and "y2" in box:
                return {
                    "x1": box["x1"],
                    "y1": box["y1"],
                    "x2": box["x2"],
                    "y2": box["y2"],
                }
            if "x" in box and "y" in box:
                w = box.get("width", box.get("w", 0))
                h = box.get("height", box.get("h", 0))
                return {
                    "x1": box["x"],
                    "y1": box["y"],
                    "x2": box["x"] + w,
                    "y2": box["y"] + h,
                }
        return {"x1": 0, "y1": 0, "x2": 0, "y2": 0}

    @classmethod
    def model_to_video(
        cls, box, letterbox_params, is_mirrored: bool = False, is_xywh: bool = False
    ):
        norm = cls.normalize_bbox(box, is_xywh)
        scale = letterbox_params["scale"]
        pad_x = letterbox_params["pad_x"]
        pad_y = letterbox_params["pad_y"]
        src_w = letterbox_params["src_w"]
        src_h = letterbox_params["src_h"]

        x1 = (norm["x1"] - pad_x) / scale
        y1 = (norm["y1"] - pad_y) / scale
        x2 = (norm["x2"] - pad_x) / scale
        y2 = (norm["y2"] - pad_y) / scale

        x1 = max(0, min(src_w, x1))
        y1 = max(0, min(src_h, y1))
        x2 = max(0, min(src_w, x2))
        y2 = max(0, min(src_h, y2))

        if is_mirrored:
            orig_x1 = x1
            x1 = src_w - x2
            x2 = src_w - orig_x1

        rx1 = round(min(x1, x2))
        ry1 = round(min(y1, y2))
        rx2 = round(max(x1, x2))
        ry2 = round(max(y1, y2))

        return {
            "x1": rx1,
            "y1": ry1,
            "x2": rx2,
            "y2": ry2,
            "width": rx2 - rx1,
            "height": ry2 - ry1,
        }

    @classmethod
    def video_to_model(cls, box, letterbox_params, is_mirrored: bool = False):
        norm = cls.normalize_bbox(box)
        scale = letterbox_params["scale"]
        pad_x = letterbox_params["pad_x"]
        pad_y = letterbox_params["pad_y"]
        src_w = letterbox_params["src_w"]
        target_dim = letterbox_params["target_dim"]

        x1 = norm["x1"]
        x2 = norm["x2"]

        if is_mirrored:
            orig_x1 = x1
            x1 = src_w - x2
            x2 = src_w - orig_x1

        mx1 = max(0, min(target_dim, x1 * scale + pad_x))
        my1 = max(0, min(target_dim, norm["y1"] * scale + pad_y))
        mx2 = max(0, min(target_dim, x2 * scale + pad_x))
        my2 = max(0, min(target_dim, norm["y2"] * scale + pad_y))

        return {
            "x1": round(mx1),
            "y1": round(my1),
            "x2": round(mx2),
            "y2": round(my2),
            "width": round(mx2 - mx1),
            "height": round(my2 - my1),
        }


class TestCoordinateMapper(unittest.TestCase):

    def test_landscape_16_9_letterbox(self):
        """Uji parameter letterbox untuk webcam 16:9 (1280x720)."""
        params = CoordinateMapperPy.compute_letterbox_params(1280, 720, 640)
        self.assertEqual(params["scale"], 0.5)
        self.assertEqual(params["nw"], 640)
        self.assertEqual(params["nh"], 360)
        self.assertEqual(params["pad_x"], 0)
        self.assertEqual(params["pad_y"], 140)
        self.assertEqual(params["aspect_label"], "16:9")

    def test_classic_4_3_letterbox(self):
        """Uji parameter letterbox untuk kamera 4:3 (640x480)."""
        params = CoordinateMapperPy.compute_letterbox_params(640, 480, 640)
        self.assertEqual(params["scale"], 1.0)
        self.assertEqual(params["nw"], 640)
        self.assertEqual(params["nh"], 480)
        self.assertEqual(params["pad_x"], 0)
        self.assertEqual(params["pad_y"], 80)
        self.assertEqual(params["aspect_label"], "4:3")

    def test_portrait_phone_9_16_letterbox(self):
        """Uji parameter letterbox untuk video portrait HP 9:16 (720x1280)."""
        params = CoordinateMapperPy.compute_letterbox_params(720, 1280, 640)
        self.assertEqual(params["scale"], 0.5)
        self.assertEqual(params["nw"], 360)
        self.assertEqual(params["nh"], 640)
        self.assertEqual(params["pad_x"], 140)
        self.assertEqual(params["pad_y"], 0)
        self.assertIn("Portrait", params["aspect_label"])

    def test_model_to_video_roundtrip_16_9(self):
        """Uji konsistensi transformasi bolak-balik (round-trip) pada 16:9."""
        params = CoordinateMapperPy.compute_letterbox_params(1280, 720, 640)
        orig_video_box = {"x1": 200, "y1": 100, "x2": 600, "y2": 500}

        # video -> model
        model_box = CoordinateMapperPy.video_to_model(orig_video_box, params)
        # model -> video
        restored = CoordinateMapperPy.model_to_video(model_box, params)

        self.assertAlmostEqual(restored["x1"], orig_video_box["x1"], delta=2)
        self.assertAlmostEqual(restored["y1"], orig_video_box["y1"], delta=2)
        self.assertAlmostEqual(restored["x2"], orig_video_box["x2"], delta=2)
        self.assertAlmostEqual(restored["y2"], orig_video_box["y2"], delta=2)

    def test_mirrored_camera_horizontal_flip(self):
        """Uji bahwa mirrored front camera membalikkan koordinat X dengan presisi."""
        params = CoordinateMapperPy.compute_letterbox_params(1280, 720, 640)
        # Kotak wajah di sisi kiri video normal: x1=100, x2=300 (lebar 200)
        orig_box = {"x1": 100, "y1": 100, "x2": 300, "y2": 350}

        # Saat mirrored, kotak harus berada di sisi kanan: x1 = 1280 - 300 = 980, x2 = 1280 - 100 = 1180
        # Simulasikan deteksi di model letterbox
        model_box = CoordinateMapperPy.video_to_model(orig_box, params, is_mirrored=False)
        mirrored_video_box = CoordinateMapperPy.model_to_video(
            model_box, params, is_mirrored=True
        )

        expected_x1 = 1280 - orig_box["x2"]
        expected_x2 = 1280 - orig_box["x1"]
        self.assertAlmostEqual(mirrored_video_box["x1"], expected_x1, delta=2)
        self.assertAlmostEqual(mirrored_video_box["x2"], expected_x2, delta=2)
        self.assertEqual(mirrored_video_box["width"], orig_box["x2"] - orig_box["x1"])

    def test_boundary_clamping(self):
        """Memastikan koordinat di luar frame di-clamp dengan aman ke resolusi video."""
        params = CoordinateMapperPy.compute_letterbox_params(1280, 720, 640)
        out_of_bounds = {"x1": -50, "y1": -20, "x2": 700, "y2": 660}
        mapped = CoordinateMapperPy.model_to_video(out_of_bounds, params)

        self.assertGreaterEqual(mapped["x1"], 0)
        self.assertGreaterEqual(mapped["y1"], 0)
        self.assertLessEqual(mapped["x2"], 1280)
        self.assertLessEqual(mapped["y2"], 720)

    def test_normalize_bbox_formats(self):
        """Uji normalisasi berbagai format bounding box."""
        # 1. [x1, y1, x2, y2]
        b1 = CoordinateMapperPy.normalize_bbox([10, 20, 100, 200])
        self.assertEqual(b1, {"x1": 10, "y1": 20, "x2": 100, "y2": 200})

        # 2. [x, y, w, h] dengan is_xywh=True
        b2 = CoordinateMapperPy.normalize_bbox([10, 20, 90, 180], is_xywh=True)
        self.assertEqual(b2, {"x1": 10, "y1": 20, "x2": 100, "y2": 200})

        # 3. {x, y, width, height}
        b3 = CoordinateMapperPy.normalize_bbox({"x": 10, "y": 20, "width": 90, "height": 180})
        self.assertEqual(b3, {"x1": 10, "y1": 20, "x2": 100, "y2": 200})


if __name__ == "__main__":
    unittest.main()
