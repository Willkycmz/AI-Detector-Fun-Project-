from ultralytics import YOLO
import shutil
import os

print("Loading models/visionx_v3/weights/best.pt...")
model = YOLO("models/visionx_v3/weights/best.pt")

print("Exporting to ONNX format (imgsz=640, simplify=True)...")
exported_path = model.export(format="onnx", imgsz=640, dynamic=False, simplify=True)
print(f"Exported successfully to: {exported_path}")

target_destinations = [
    "models/visionx_v3/visionx_v3.onnx",
    "web/public/models/visionx_v3.onnx",
    "web/dist/models/visionx_v3.onnx"
]

for dest in target_destinations:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(exported_path, dest)
    size_mb = os.path.getsize(dest) / (1024 * 1024)
    print(f"Copied to {dest} ({size_mb:.2f} MB)")
