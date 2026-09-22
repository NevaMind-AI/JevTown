"""Import the prototype's NPC sheets, metadata and idle sprites (requires Pillow).

python scripts/import-room-npcs.py D:/lab/project-myrmidon-map-prototype
Then run python scripts/export-room-maps.py to place the NPCs.
"""
import argparse
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('prototype', type=Path)
    source = parser.parse_args().prototype
    handoff = source / 'handoff/npc-entities.json'
    roster = json.loads(handoff.read_text(encoding='utf8'))
    destination = ROOT / 'public/assets/room-npcs'
    destination.mkdir(parents=True, exist_ok=True)
    for npc in roster['definitions']:
        sheet = source / 'source/imagegen-v2' / npc['image']
        metadata = source / 'source/imagegen-v2' / npc['metadata']
        data = json.loads(metadata.read_text(encoding='utf8'))
        frame = data['frames'][data['animations']['idle']['frames'][0]]
        shutil.copy2(sheet, destination / sheet.name)
        shutil.copy2(metadata, destination / metadata.name)
        with Image.open(sheet) as image:
            x, y, w, h = (frame[key] for key in ('x', 'y', 'w', 'h'))
            image.crop((x, y, x + w, y + h)).save(destination / f'{npc["id"]}-idle.png')
    shutil.copy2(handoff, ROOT / 'art/room-npcs.json')
    print(f'Imported {len(roster["definitions"])} NPC sheets and idle sprites.')


if __name__ == '__main__':
    main()
