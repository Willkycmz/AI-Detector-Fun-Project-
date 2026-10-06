from pathlib import Path
from collections import Counter
import shutil
import yaml

VEHICLE_ROOT = Path('datasets/raw/vehicle_license')
OUT_ROOT = Path('datasets/processed_vehicle_v2')

# Vehicle-License V2 classes from user's data.yaml
# 0 Bicycle, 1 Bus, 2 Car, 3 E-bike, 4 Jeep, 5 License-Plate,
# 6 Motorcycle, 7 Tricycle, 8 Truck
VEHICLE_MAP = {
    0: 0,  # Bicycle -> bicycle
    1: 1,  # Bus -> bus
    2: 2,  # Car -> car
    6: 3,  # Motorcycle -> motorcycle
    8: 4,  # Truck -> truck
}

TARGET_CLASSES = ['bicycle', 'bus', 'car', 'motorcycle', 'truck']
EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}


def read_yaml(path):
    with path.open('r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def split_dirs(root, split):
    choices = [
        (root / 'images' / split, root / 'labels' / split),
        (root / split / 'images', root / split / 'labels'),
    ]
    for img, lab in choices:
        if img.is_dir() and lab.is_dir():
            return img, lab
    raise FileNotFoundError(f'Tidak menemukan images/labels untuk split={split} di {root}')


def read_labels(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding='utf-8').splitlines():
        parts = line.strip().split()
        if len(parts) >= 5:
            rows.append(parts[:5])
    return rows


def main():
    if not VEHICLE_ROOT.is_dir():
        raise FileNotFoundError(f'Dataset kendaraan tidak ditemukan: {VEHICLE_ROOT}')

    yaml_path = VEHICLE_ROOT / 'data.yaml'
    if not yaml_path.is_file():
        raise FileNotFoundError(f'Tidak menemukan {yaml_path}')

    data = read_yaml(yaml_path)
    names = data.get('names', [])
    if isinstance(names, dict):
        names = [names[k] for k in sorted(names, key=lambda k: int(k))]

    expected = ['Bicycle', 'Bus', 'Car', 'E-bike', 'Jeep', 'License-Plate', 'Motorcycle', 'Tricycle', 'Truck']
    if list(names) != expected:
        raise ValueError(
            'Urutan kelas Vehicle-License berbeda dari yang diharapkan.\n'
            f'Ditemukan: {names}\nDiharapkan: {expected}'
        )

    if OUT_ROOT.exists():
        raise FileExistsError(
            f'{OUT_ROOT} sudah ada. Jangan ditimpa. Rename folder tersebut dulu jika itu hanya hasil percobaan.'
        )

    for split in ['train', 'val', 'test']:
        (OUT_ROOT / 'images' / split).mkdir(parents=True, exist_ok=True)
        (OUT_ROOT / 'labels' / split).mkdir(parents=True, exist_ok=True)

    split_map = [('train', 'train'), ('valid', 'val'), ('test', 'test')]
    totals = Counter()
    class_counts = {s: Counter() for s in ['train', 'val', 'test']}

    for src_split, out_split in split_map:
        img_dir, lab_dir = split_dirs(VEHICLE_ROOT, src_split)
        print(f'\n[{src_split} -> {out_split}]')

        for image in sorted(img_dir.iterdir()):
            if image.suffix.lower() not in EXTS:
                continue

            src_label = lab_dir / f'{image.stem}.txt'
            rows = read_labels(src_label)
            new_rows = []

            for row in rows:
                old_id = int(float(row[0]))
                if old_id in VEHICLE_MAP:
                    new_id = VEHICLE_MAP[old_id]
                    new_rows.append([str(new_id), *row[1:5]])
                    class_counts[out_split][new_id] += 1

            # Skip images with none of the 5 target classes.
            if not new_rows:
                continue

            dst_image = OUT_ROOT / 'images' / out_split / f'vl_{image.name}'
            dst_label = OUT_ROOT / 'labels' / out_split / f'vl_{image.stem}.txt'
            shutil.copy2(image, dst_image)
            dst_label.write_text(
                ''.join(' '.join(r) + '\n' for r in new_rows),
                encoding='utf-8'
            )
            totals[f'{out_split}_images'] += 1
            totals[f'{out_split}_objects'] += len(new_rows)

        print(f'Images: {totals[f"{out_split}_images"]}')
        print(f'Objects: {totals[f"{out_split}_objects"]}')

    out_yaml = {
        'path': '.',
        'train': 'images/train',
        'val': 'images/val',
        'test': 'images/test',
        'nc': len(TARGET_CLASSES),
        'names': TARGET_CLASSES,
    }
    with (OUT_ROOT / 'data.yaml').open('w', encoding='utf-8') as f:
        yaml.safe_dump(out_yaml, f, sort_keys=False, allow_unicode=True)

    print('\n=== RINGKASAN ===')
    for split in ['train', 'val', 'test']:
        print(f'\n{split}: {totals[f"{split}_images"]} images / {totals[f"{split}_objects"]} objects')
        for cid, name in enumerate(TARGET_CLASSES):
            print(f'  {cid}: {name:<10} {class_counts[split][cid]}')

    print('\nSELESAI')
    print(f'Dataset kendaraan: {OUT_ROOT}')
    print(f'YAML: {OUT_ROOT / "data.yaml"}')
    print('Dataset V1 dan processed_v2 TIDAK disentuh.')


if __name__ == '__main__':
    main()
