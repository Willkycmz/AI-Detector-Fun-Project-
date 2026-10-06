from pathlib import Path
from collections import Counter
import shutil
import yaml

# ============================================================
# VisionX V2 dataset builder
# - Keeps V1 untouched
# - Merges V1 classes + 5 vehicle classes from Vehicle-License V2
# ============================================================

V1_ROOT = Path('datasets/processed')
VEHICLE_ROOT = Path('datasets/raw/vehicle_license')
OUT_ROOT = Path("datasets/processed_vehicle_v2")

TARGET_CLASSES = [
    'person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone',
    'bicycle', 'bus', 'car', 'motorcycle', 'truck'
]

# Vehicle-License V2 class IDs from the data.yaml the user provided:
# 0 Bicycle, 1 Bus, 2 Car, 3 E-bike, 4 Jeep, 5 License-Plate,
# 6 Motorcycle, 7 Tricycle, 8 Truck
VEHICLE_MAP = {
    0: 7,   # Bicycle -> bicycle
    1: 8,   # Bus -> bus
    2: 9,   # Car -> car
    6: 10,  # Motorcycle -> motorcycle
    8: 11,  # Truck -> truck
}

EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}

def norm_name(x):
    return str(x).strip().lower().replace('-', '_').replace(' ', '_')

def read_yaml(path):
    with path.open('r', encoding='utf-8') as f:
        return yaml.safe_load(f)

def get_names(data):
    names = data.get('names')
    if isinstance(names, dict):
        return [names[k] for k in sorted(names, key=lambda k: int(k))]
    if isinstance(names, list):
        return names
    raise ValueError('data/classes yaml tidak punya field names yang dikenali')

def split_dirs(root, split):
    # Supports both layouts:
    # root/images/train + root/labels/train
    # root/train/images + root/train/labels
    choices = [
        (root / 'images' / split, root / 'labels' / split),
        (root / split / 'images', root / split / 'labels'),
    ]
    for img, lab in choices:
        if img.is_dir() and lab.is_dir():
            return img, lab
    raise FileNotFoundError(f'Tidak menemukan images/labels untuk split={split} di {root}')

def label_rows(label_path):
    if not label_path.exists():
        return []
    rows = []
    for line in label_path.read_text(encoding='utf-8').splitlines():
        p = line.strip().split()
        if len(p) >= 5:
            rows.append(p[:5])
    return rows

def write_rows(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(' '.join(r) + '\n' for r in rows), encoding='utf-8')

def copy_split(source_root, source_split, out_split, prefix, remap, filter_unmapped=False, stats=None):
    img_dir, lab_dir = split_dirs(source_root, source_split)
    out_img = OUT_ROOT / 'images' / out_split
    out_lab = OUT_ROOT / 'labels' / out_split
    out_img.mkdir(parents=True, exist_ok=True)
    out_lab.mkdir(parents=True, exist_ok=True)

    for image in sorted(img_dir.iterdir()):
        if image.suffix.lower() not in EXTS:
            continue
        src_label = lab_dir / f'{image.stem}.txt'
        rows = label_rows(src_label)
        new_rows = []
        for row in rows:
            old_id = int(float(row[0]))
            if old_id in remap:
                new_rows.append([str(remap[old_id]), *row[1:5]])
            elif not filter_unmapped:
                raise ValueError(f'Class ID {old_id} tidak punya mapping: {src_label}')

        # Vehicle images containing only excluded classes are dropped.
        if filter_unmapped and not new_rows:
            continue

        dst_image = out_img / f'{prefix}_{image.name}'
        dst_label = out_lab / f'{prefix}_{image.stem}.txt'
        shutil.copy2(image, dst_image)
        write_rows(dst_label, new_rows)
        stats['images'] += 1
        stats['objects'] += len(new_rows)
        for r in new_rows:
            stats['classes'][int(r[0])] += 1

def build_v1_remap():
    candidates = [
        Path('datasets/metadata/classes.yaml'),
        V1_ROOT / 'classes.yaml',
        V1_ROOT / 'metadata' / 'classes.yaml',
    ]
    for p in candidates:
        if p.is_file():
            names = get_names(read_yaml(p))
            target = {norm_name(n): i for i, n in enumerate(TARGET_CLASSES)}
            remap = {}
            for old_id, name in enumerate(names):
                key = norm_name(name)
                if key not in target:
                    raise ValueError(f"Kelas V1 '{name}' belum ada di TARGET_CLASSES")
                remap[old_id] = target[key]
            print(f'V1 classes dari {p}: {names}')
            return remap
    # Known VisionX V1 fallback from the project configuration/history.
    names = ['person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone']
    target = {norm_name(n): i for i, n in enumerate(TARGET_CLASSES)}
    return {i: target[norm_name(n)] for i, n in enumerate(names)}

def validate():
    total = Counter()
    for split in ['train', 'val', 'test']:
        imgs = list((OUT_ROOT / 'images' / split).glob('*'))
        labs = list((OUT_ROOT / 'labels' / split).glob('*.txt'))
        total[f'{split}_images'] = len([p for p in imgs if p.suffix.lower() in EXTS])
        total[f'{split}_labels'] = len(labs)
        for lab in labs:
            for row in label_rows(lab):
                cid = int(row[0])
                if not 0 <= cid < len(TARGET_CLASSES):
                    raise ValueError(f'Class ID invalid {cid}: {lab}')
                coords = list(map(float, row[1:5]))
                if not all(0 <= x <= 1 for x in coords):
                    raise ValueError(f'Koordinat di luar 0..1: {lab}: {row}')
                total[f'{split}_class_{cid}'] += 1
    return total

def main():
    if not V1_ROOT.is_dir():
        raise FileNotFoundError(f'V1 tidak ditemukan: {V1_ROOT}')
    if not VEHICLE_ROOT.is_dir():
        raise FileNotFoundError(f'Vehicle-License tidak ditemukan: {VEHICLE_ROOT}')
    if OUT_ROOT.exists():
        raise FileExistsError(f'{OUT_ROOT} sudah ada. Hapus/rename folder ini dulu agar aman.')

    for split in ['train', 'val', 'test']:
        (OUT_ROOT / 'images' / split).mkdir(parents=True, exist_ok=True)
        (OUT_ROOT / 'labels' / split).mkdir(parents=True, exist_ok=True)

    v1_map = build_v1_remap()

    print('\n[1/2] Menyalin VisionX V1...')
    v1_stats = {}
    for split in ['train', 'val', 'test']:
        c = Counter()
        copy_split(V1_ROOT, split, split, 'v1', v1_map, False, c)
        v1_stats[split] = c
        print(f'  {split}: {c["images"]} images, {c["objects"]} objects')

    # Vehicle-License calls validation split 'valid', while VisionX uses 'val'.
    vehicle_split_map = [('train', 'train'), ('valid', 'val'), ('test', 'test')]
    print('\n[2/2] Menyalin Vehicle-License (5 kelas kendaraan)...')
    for src_split, out_split in vehicle_split_map:
        c = Counter()
        c['classes'] = Counter()
        copy_split(VEHICLE_ROOT, src_split, out_split, 'vl', VEHICLE_MAP, True, c)
        print(f'  {src_split} -> {out_split}: {c["images"]} images, {c["objects"]} objects')

    data = {
        'path': '.',
        'train': 'images/train',
        'val': 'images/val',
        'test': 'images/test',
        'nc': len(TARGET_CLASSES),
        'names': TARGET_CLASSES,
    }
    with (OUT_ROOT / 'data.yaml').open('w', encoding='utf-8') as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)

    print('\nVALIDASI...')
    totals = validate()
    for split in ['train', 'val', 'test']:
        print(f'  {split}: {totals[f"{split}_images"]} images / {totals[f"{split}_labels"]} labels')
        for cid, name in enumerate(TARGET_CLASSES):
            print(f'    {cid:2d} {name:<12} {totals[f"{split}_class_{cid}"]} objects')

    print('\nSELESAI')
    print(f'Dataset V2 : {OUT_ROOT}')
    print(f'YAML       : {OUT_ROOT / "data.yaml"}')
    print('Dataset V1 asli TIDAK diubah.')

if __name__ == '__main__':
    main()
