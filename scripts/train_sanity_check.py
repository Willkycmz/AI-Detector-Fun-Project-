"""
VisionX V3 - 1-Epoch Sanity Check
Runs 1 full epoch on CPU to measure:
1. Exact elapsed time for 1 epoch (training + validation)
2. Loss progression (box_loss, cls_loss, dfl_loss)
3. Compatibility with nc=14 and empty placeholder classes (cooler_hp, kunci_cakram)
4. Extrapolated time for 20 epochs
"""

import time
import os
import sys
from pathlib import Path
from ultralytics import YOLO

def main():
    print("=" * 60)
    print(" VisionX V3 Fine-Tuning: 1-Epoch Sanity Check")
    print("=" * 60)

    model_path = Path("models/visionx_v2/weights/best.pt").resolve()
    data_path = Path("datasets/processed_v2/dataset.yaml").resolve()

    if not model_path.exists():
        print(f"ERROR: Model checkpoint not found at: {model_path}")
        sys.exit(1)

    if not data_path.exists():
        print(f"ERROR: Dataset YAML not found at: {data_path}")
        sys.exit(1)

    print(f"Base Checkpoint : {model_path}")
    print(f"Dataset Config  : {data_path}")
    print("Device          : CPU (workers=4)")
    print("Batch & Imgsz   : batch=16, imgsz=640")
    print("Optimizer & LR  : auto (AdamW), lr0=0.005, lrf=0.01")
    print("Epochs          : 1 (Sanity Check)")
    print("-" * 60)

    start_time = time.time()

    model = YOLO(str(model_path))
    
    # Train for 1 epoch
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
        name="visionx_v3_sanity",
        exist_ok=True,
        verbose=True,
        seed=42
    )

    elapsed_sec = time.time() - start_time
    elapsed_min = elapsed_sec / 60.0

    print("\n" + "=" * 60)
    print(" 1-EPOCH SANITY CHECK COMPLETED")
    print("=" * 60)
    print(f"Elapsed Time for 1 Epoch: {elapsed_sec:.2f} seconds ({elapsed_min:.2f} minutes)")
    
    # Extrapolate for 20 epochs
    est_20_epochs_sec = elapsed_sec * 20
    est_20_epochs_hours = est_20_epochs_sec / 3600.0
    print(f"Extrapolated Time for 20 Epochs: {est_20_epochs_sec:.1f}s ({est_20_epochs_hours:.2f} hours)")
    print("-" * 60)

if __name__ == "__main__":
    main()
