import json
import shutil
from pathlib import Path

notebook = {
    "nbformat": 4,
    "nbformat_minor": 0,
    "metadata": {
        "colab": {
            "provenance": [],
            "gpuType": "T4"
        },
        "kernelspec": {
            "name": "python3",
            "display_name": "Python 3"
        },
        "language_info": {
            "name": "python"
        },
        "accelerator": "GPU"
    },
    "cells": [
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "# VisionX V4 — Fine-Tuning 21 Kelas (Google Colab GPU)\n",
                "Notebook ini disiapkan untuk melatih model **VisionX V4 (21 kelas)** menggunakan GPU T4 gratis di Google Colab.\n",
                "\n",
                "### Checklist Persiapan Sebelum Klik 'Run All':\n",
                "1. **Aktifkan GPU**: Menu `Runtime` > `Change runtime type` > Pilih `T4 GPU` > `Save`.\n",
                "2. **Upload 2 file ke Google Drive (My Drive / root)**:\n",
                "   - `processed_v3.zip` (Dataset 15.097 gambar, 21 kelas)\n",
                "   - `visionx_v3_best.pt` (Checkpoint bobot model V3)"
            ]
        },
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "### Cell 1: Hubungkan Google Drive & Install Ultralytics"
            ]
        },
        {
            "cell_type": "code",
            "metadata": {},
            "execution_count": None,
            "outputs": [],
            "source": [
                "from google.colab import drive\n",
                "import os, sys\n",
                "\n",
                "# 1. Hubungkan Google Drive\n",
                "drive.mount('/content/drive')\n",
                "\n",
                "# 2. Install Ultralytics YOLO\n",
                "!pip install -q ultralytics\n",
                "\n",
                "import torch\n",
                "print('\\n--- Environment Check ---')\n",
                "print('PyTorch Version:', torch.__version__)\n",
                "print('CUDA Available :', torch.cuda.is_available())\n",
                "if torch.cuda.is_available():\n",
                "    print('GPU Device     :', torch.cuda.get_device_name(0))\n",
                "    vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)\n",
                "    print(f'VRAM           : {vram:.2f} GB')\n",
                "else:\n",
                "    print('PERINGATAN: GPU belum aktif! Silakan buka Runtime > Change runtime type > Pilih T4 GPU.')\n"
            ]
        },
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "### Cell 2: Ekstrak Dataset processed_v3 dari Google Drive"
            ]
        },
        {
            "cell_type": "code",
            "metadata": {},
            "execution_count": None,
            "outputs": [],
            "source": [
                "import zipfile, os, yaml\n",
                "\n",
                "# Cari processed_v3.zip di Drive\n",
                "ZIP_PATH = '/content/drive/MyDrive/processed_v3.zip'\n",
                "if not os.path.exists(ZIP_PATH):\n",
                "    for root, dirs, files in os.walk('/content/drive/MyDrive'):\n",
                "        if 'processed_v3.zip' in files:\n",
                "            ZIP_PATH = os.path.join(root, 'processed_v3.zip')\n",
                "            break\n",
                "\n",
                "print(f'Menggunakan file: {ZIP_PATH}')\n",
                "DEST_DIR = '/content/datasets/processed_v3'\n",
                "os.makedirs(DEST_DIR, exist_ok=True)\n",
                "\n",
                "print('Mengekstrak dataset ke /content/datasets/processed_v3...')\n",
                "with zipfile.ZipFile(ZIP_PATH, 'r') as zip_ref:\n",
                "    zip_ref.extractall(DEST_DIR)\n",
                "\n",
                "# Update path di dataset.yaml ke path absolut Colab\n",
                "yaml_path = os.path.join(DEST_DIR, 'dataset.yaml')\n",
                "with open(yaml_path, 'r') as f:\n",
                "    cfg = yaml.safe_load(f)\n",
                "\n",
                "cfg['path'] = DEST_DIR\n",
                "with open(yaml_path, 'w') as f:\n",
                "    yaml.dump(cfg, f, default_flow_style=False, sort_keys=False)\n",
                "\n",
                "print('Ekstraksi selesai!')\n",
                "print(f'Train images : {len(os.listdir(os.path.join(DEST_DIR, \"images/train\")))}')\n",
                "print(f'Val images   : {len(os.listdir(os.path.join(DEST_DIR, \"images/val\")))}')\n",
                "print(f'Test images  : {len(os.listdir(os.path.join(DEST_DIR, \"images/test\")))}')\n",
                "print(f'Total Classes: {len(cfg[\"names\"])}')\n"
            ]
        },
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "### Cell 3: Load Checkpoint Base VisionX V3"
            ]
        },
        {
            "cell_type": "code",
            "metadata": {},
            "execution_count": None,
            "outputs": [],
            "source": [
                "# Cari visionx_v3_best.pt di Drive\n",
                "MODEL_PATH = '/content/drive/MyDrive/visionx_v3_best.pt'\n",
                "if not os.path.exists(MODEL_PATH):\n",
                "    for root, dirs, files in os.walk('/content/drive/MyDrive'):\n",
                "        if 'visionx_v3_best.pt' in files:\n",
                "            MODEL_PATH = os.path.join(root, 'visionx_v3_best.pt')\n",
                "            break\n",
                "\n",
                "print(f'Checkpoint model ditemukan: {MODEL_PATH}')\n",
                "from ultralytics import YOLO\n",
                "model = YOLO(MODEL_PATH)\n",
                "print(f'Model V3 ter-load dengan {len(model.names)} kelas awal.')\n"
            ]
        },
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "### Cell 4: Training VisionX V4 (20 Epochs di GPU T4)"
            ]
        },
        {
            "cell_type": "code",
            "metadata": {},
            "execution_count": None,
            "outputs": [],
            "source": [
                "import time\n",
                "t0 = time.time()\n",
                "\n",
                "results = model.train(\n",
                "    data='/content/datasets/processed_v3/dataset.yaml',\n",
                "    epochs=20,\n",
                "    patience=6,\n",
                "    batch=16,\n",
                "    imgsz=640,\n",
                "    device=0,\n",
                "    optimizer='auto',\n",
                "    lr0=0.005,\n",
                "    lrf=0.01,\n",
                "    project='runs/detect',\n",
                "    name='visionx_v4',\n",
                "    exist_ok=True,\n",
                "    verbose=True,\n",
                "    seed=42\n",
                ")\n",
                "\n",
                "t_total = time.time() - t0\n",
                "print(f'\\nTraining selesai dalam {t_total/60:.2f} menit ({t_total/20:.1f} detik/epoch)!')\n"
            ]
        },
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "### Cell 5: Evaluasi pada Test Set (Benchmark V4)"
            ]
        },
        {
            "cell_type": "code",
            "metadata": {},
            "execution_count": None,
            "outputs": [],
            "source": [
                "# Validasi pada test split\n",
                "import os\n",
                "from pathlib import Path\n",
                "from ultralytics import YOLO\n",
                "\n",
                "best_v4_path = '/content/runs/detect/runs/detect/visionx_v4/weights/best.pt'\n",
                "if not os.path.exists(best_v4_path):\n",
                "    candidates = list(Path('/content').glob('**/visionx_v4/weights/best.pt'))\n",
                "    if candidates:\n",
                "        best_v4_path = str(candidates[0])\n",
                "\n",
                "print(f'Menggunakan bobot: {best_v4_path}')\n",
                "model_v4 = YOLO(best_v4_path)\n",
                "test_metrics = model_v4.val(data='/content/datasets/processed_v3/dataset.yaml', split='test', imgsz=640, device=0)\n",
                "print(f'mAP50 Test     : {test_metrics.box.map50:.4f}')\n",
                "print(f'mAP50-95 Test  : {test_metrics.box.map:.4f}')\n"
            ]
        },
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "### Cell 6: Simpan Hasil Training Kembali ke Google Drive"
            ]
        },
        {
            "cell_type": "code",
            "metadata": {},
            "execution_count": None,
            "outputs": [],
            "source": [
                "import os, shutil\n",
                "from pathlib import Path\n",
                "\n",
                "run_dir = '/content/runs/detect/runs/detect/visionx_v4'\n",
                "if not os.path.exists(run_dir):\n",
                "    candidates = list(Path('/content').glob('**/visionx_v4'))\n",
                "    if candidates:\n",
                "        run_dir = str(candidates[0])\n",
                "\n",
                "out_zip = '/content/drive/MyDrive/visionx_v4_results.zip'\n",
                "print(f'Mengompres {run_dir} ke {out_zip}...')\n",
                "!zip -q -r \"{out_zip}\" \"{run_dir}\"\n",
                "\n",
                "if os.path.exists(out_zip):\n",
                "    print(f'BERHASIL! File tersimpan di Google Drive: {out_zip} ({os.path.getsize(out_zip)/1024/1024:.2f} MB)')\n",
                "    print('Silakan download visionx_v4_results.zip ke laptop Anda dan ekstrak ke models/visionx_v4/ !')\n",
                "else:\n",
                "    print('Gagal menyimpan zip ke Google Drive.')\n"
            ]
        }
    ]
}

def main():
    Path("notebooks").mkdir(exist_ok=True)
    Path("outputs").mkdir(exist_ok=True)
    
    nb_path_notebooks = Path("notebooks/visionx_v4_colab_training.ipynb")
    nb_path_outputs = Path("outputs/visionx_v4_colab_training.ipynb")
    
    content = json.dumps(notebook, indent=2)
    nb_path_notebooks.write_text(content, encoding="utf-8")
    nb_path_outputs.write_text(content, encoding="utf-8")
    print(f"Colab notebook created at {nb_path_notebooks} and {nb_path_outputs}")

if __name__ == "__main__":
    main()
