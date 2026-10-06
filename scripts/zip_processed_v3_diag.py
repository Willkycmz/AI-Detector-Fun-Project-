import os
import zipfile
from pathlib import Path

def main():
    root = Path("datasets/processed_v3_diag")
    out_zip = Path("outputs/processed_v3_diag.zip")
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    
    if out_zip.exists():
        out_zip.unlink()
        
    print(f"Creating {out_zip} from {root}...", flush=True)
    file_count = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for foldername, subfolders, filenames in os.walk(root):
            for filename in filenames:
                if filename.endswith(".cache"):
                    continue
                filepath = os.path.join(foldername, filename)
                arcname = os.path.relpath(filepath, root)
                zf.write(filepath, arcname)
                file_count += 1
                if file_count % 5000 == 0:
                    print(f"  Zipped {file_count} files...", flush=True)
                    
    size_mb = out_zip.stat().st_size / (1024 * 1024)
    print(f"Completed! Zipped {file_count} files into {out_zip} ({size_mb:.2f} MB)", flush=True)

if __name__ == "__main__":
    main()
