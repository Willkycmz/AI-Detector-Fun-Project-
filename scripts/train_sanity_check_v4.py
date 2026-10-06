"""
VisionX V4 - 1-Epoch CPU Sanity Check
Validates:
1. Base checkpoint: models/visionx_v3/weights/best.pt
2. Remapping detection head from nc=14 to nc=21
3. Compatibility with empty classes (cooler_hp, kunci_cakram)
4. Measure exact 1-epoch time on CPU for estimation
"""

import time
import os
import sys
from pathlib import Path
from ultralytics import YOLO

def main():
    print("=" * 65)
    print(" VisionX V4 (21 Classes) Fine-Tuning: 1-Epoch CPU Sanity Check")
    print("=" * 65)

    model_path = Path("models/visionx_v3/weights/best.pt").resolve()
    data_path = Path("datasets/processed_v3/dataset.yaml").resolve()

    if not model_path.exists():
        print(f"ERROR: Model checkpoint not found at: {model_path}")
        sys.exit(1)

    if not data_path.exists():
        print(f"ERROR: Dataset YAML not found at: {data_path}")
        sys.exit(1)

    print(f"Base Checkpoint : {model_path}")
    print(f"Dataset Config  : {data_path}")
    print("Device          : CPU")
    print("Batch & Imgsz   : batch=16, imgsz=640")
    print("Optimizer & LR  : auto (AdamW), lr0=0.005, lrf=0.01")
    print("Epochs          : 1 (Sanity Check)")
    print("-" * 65)

    start_time = time.time()

    model = YOLO(str(model_path))

    results = model.train(
        data=str(data_path),
        epochs=1,
        patience=6,
        batch=16,
        imgsz=640,
        device="cpu",
        workers=4,
        optimizer="auto",
        lr0=0.005,
        lrf=0.01,
        project="runs/detect",
        name="visionx_v4_sanity",
        exist_ok=True,
        verbose=True,
        seed=42
    )

    elapsed_sec = time.time() - start_time
    elapsed_min = elapsed_sec / 60.0

    print("\n" + "=" * 65)
    print(" 1-EPOCH SANITY CHECK COMPLETED")
    print("=" * 65)
    print(f"Elapsed Time for 1 Epoch: {elapsed_sec:.2f} seconds ({elapsed_min:.2f} minutes)")
    
    est_20_epochs_sec = elapsed_sec * 20
    est_20_epochs_hours = est_20_epochs_sec / 3600.0
    print(f"Extrapolated Time for 20 Epochs on CPU: {est_20_epochs_sec:.1f}s ({est_20_epochs_hours:.2f} hours)")
    print("-" * 65)

if __name__ == "__main__":
    main()
