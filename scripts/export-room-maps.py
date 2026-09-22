"""Export the room package from checked-in source layouts and the asset recipe.

Run from any directory: python scripts/export-room-maps.py
Coordinates stay in source pixels; the runtime uses 32px tiles and a 20px foot box.
"""
import json
import math
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TILE = 32
FOOT = 10


def read(path):
    return json.loads(path.read_text(encoding='utf8'))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def inside(x, y, polygon):
    result = False
    for (ax, ay), (bx, by) in zip(polygon, polygon[1:] + polygon[:1]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            result = not result
    return result


def collision(source, ids):
    rects = {c['id']: c['rect'] for c in source['collisions']}
    assert set(ids) <= rects.keys(), source['id']
    width, height = math.ceil(source['width'] / TILE), math.ceil(source['height'] / TILE)
    rows = []
    for row in range(height):
        cells = []
        for col in range(width):
            x, y = col * TILE + TILE // 2, row * TILE + TILE // 2
            on_floor = all(
                any(inside(x + dx, y + dy, p) for p in source['walkable'])
                for dx, dy in [(0, 0), (-FOOT, -FOOT), (-FOOT, FOOT), (FOOT, -FOOT), (FOOT, FOOT)]
            )
            blocked = any(
                x + FOOT > rx and x - FOOT < rx + rw and y + FOOT > ry and y - FOOT < ry + rh
                for rx, ry, rw, rh in (rects[ident] for ident in ids)
            )
            cells.append('.' if on_floor and not blocked else '#')
        rows.append(''.join(cells))
    return rows


def nearest(point, grid, excluded=()):
    candidates = [
        ((x * TILE + 16 - point[0]) ** 2 + (y * TILE + 16 - point[1]) ** 2, x, y)
        for y, row in enumerate(grid)
        for x, cell in enumerate(row)
        if cell == '.' and (x, y) not in excluded
    ]
    distance, x, y = min(candidates)
    assert distance <= (TILE * 2) ** 2, f'No walkable tile near {point}'
    return [x, y]


def reachable(grid, start, portals):
    # Portal tiles are endpoints: walking onto one leaves the room.
    seen, queue = {tuple(start)}, deque([tuple(start)])
    while queue:
        x, y = queue.popleft()
        for nx, ny in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]:
            point = (nx, ny)
            if point in seen or not (0 <= ny < len(grid) and 0 <= nx < len(grid[ny])):
                continue
            if grid[ny][nx] != '.':
                continue
            seen.add(point)
            if point not in portals:
                queue.append(point)
    return seen


def export():
    recipe = read(ROOT / 'art/room-maps.json')
    authored_interactions = {
        entity_id
        for path in recipe.get('stories', [])
        for entity_id in read(ROOT / 'public/content/remaining-time' / path)['interactions']
    }
    roster = read(ROOT / 'art/room-npcs.json')
    portal_recipe = read(ROOT / 'art/room-portals.json')
    npc_definitions = {npc['id']: npc for npc in roster['definitions']}
    metadata = {ident: read(ROOT / f'public/assets/{ident}' / recipe.get('layoutFiles', {}).get(ident, 'layout.json'))
                for ident in recipe['scenes']}
    placements = {ident: data.get('portalPlacement', portal_recipe['scenes'][ident])
                  for ident, data in metadata.items()}
    sources = {ident: data['sourceLayout'] for ident, data in metadata.items()}
    scenes, maps, interactions, npc_interactions = [], {}, {}, {}
    for ident, source in sources.items():
        assert source['id'] == ident
        grid = collision(source, metadata[ident].get('collisionIds', recipe['collisionIds'].get(ident, [])))
        # Authored grid rectangles open doorways and stairs through building footprints.
        for x, y, width, height in recipe.get('passages', {}).get(ident, []):
            assert all(type(n) is int for n in (x, y, width, height))
            assert 0 <= x < x + width <= len(grid[0]) and 0 <= y < y + height <= len(grid)
            for row in range(y, y + height):
                grid[row] = grid[row][:x] + '.' * width + grid[row][x + width:]
        placement = placements[ident]
        anchors = placement['anchors']
        portal_tiles, occupied, entities = {}, set(), []
        for portal in placement['portals']:
            tiles = portal['tiles']
            assert tiles and portal['id'] not in portal_tiles, f'{ident}: invalid portal'
            for point in tiles:
                assert len(point) == 2 and all(type(n) is int for n in point), point
                x, y = point
                assert 0 <= y < len(grid) and 0 <= x < len(grid[y]) and grid[y][x] == '.', f'{ident}: blocked portal tile {point}'
                assert tuple(point) not in occupied, f'{ident}: overlapping portal tile {point}'
                occupied.add(tuple(point))
            portal_tiles[portal['id']] = tiles
            destination = portal['destination']
            target = sources[destination['scene']]
            assert destination['anchor'] in placements[destination['scene']]['anchors'], destination
            entity_id = ident + '.' + portal['id']
            sprite = portal.get('sprite', portal_recipe['sprite'])
            assert (ROOT / 'public' / sprite['image']).is_file(), sprite['image']
            entities.append({
                'id': entity_id, 'name': portal['name'], 'position': tiles[0],
                'portalTiles': tiles, 'character': 'sprite', 'sprite': sprite,
                'portal': destination,
            })
            interactions[entity_id] = {
                'text': '通往' + target['name'] + '。',
                'choices': [{'id': 'travel', 'text': '前往' + target['name'], 'effects': [{'op': 'travel'}]}],
            }
        for point in anchors.values():
            assert len(point) == 2 and all(type(n) is int for n in point), point
            x, y = point
            assert 0 <= y < len(grid) and 0 <= x < len(grid[y]) and grid[y][x] == '.', f'{ident}: blocked anchor {point}'
            assert tuple(point) not in occupied, f'{ident}: anchor inside portal {point}'
        accessible = reachable(grid, anchors['start'], occupied)
        assert all(tuple(p) in accessible for p in anchors.values()), f'{ident}: unreachable arrival'
        assert all(any(tuple(p) in accessible for p in tiles) for tiles in portal_tiles.values()), f'{ident}: unreachable exits'
        art = [{'image': f'assets/{ident}/{metadata[ident]["background"]}', 'position': [0, 0], 'depth': -1}]
        objects = metadata[ident].get('objects', [])
        depths = {o['id']: (o['entity']['position'][1] + 1) * TILE if 'entity' in o
                  else round(o['position'][1] + o['footpoint'][1]) for o in objects}
        for obj in objects:
            depth = depths[obj['id']]
            if obj['id'] in ['bed-rug', 'doormat']:
                depth = 0
            elif obj['id'].startswith('cabinet-'):
                depth = depths['cabinet'] + 1
            elif obj['id'].startswith('desk-') or obj['id'] == 'inkwell-quill':
                depth = depths['desk'] + 1
            depth = obj.get('depth', depth)
            visual = {'image': f'assets/{ident}/{obj["image"]}', 'position': obj['position'], 'size': obj['size'], 'depth': depth}
            if 'entity' in obj:
                entity = obj['entity']
                x, y = entity['position']
                assert type(x) is int and type(y) is int and 0 < x < len(grid[0]) - 1 and 0 < y < len(grid) - 1
                assert (x, y) not in occupied | {tuple(p) for p in anchors.values()} | {tuple(e['position']) for e in entities}
                assert any(inside(x * TILE + 16, y * TILE + 16, p) for p in source['walkable'])
                # The fixed entity occupies this tile; the rest of the furniture footprint stays in the grid.
                grid[y] = grid[y][:x] + '.' + grid[y][x + 1:]
                entities.append({**entity, 'character': 'sprite', 'sprite': {
                    'image': visual['image'], 'size': obj['size'],
                    'offset': [obj['position'][0] - x * TILE, obj['position'][1] - y * TILE],
                }})
            else:
                art.append(visual)
            assert (ROOT / 'public' / visual['image']).is_file(), visual['image']
        for visual in art:
            assert (ROOT / 'public' / visual['image']).is_file(), visual['image']
        player_scale = recipe.get('playerScale', {}).get(ident, source.get('characterScale', 2.5))
        assert 1 <= player_scale <= 3, f'{ident}: unsupported player scale'
        npc_occupied = occupied | {tuple(p) for p in anchors.values()} | {tuple(e['position']) for e in entities}
        for npc in roster['instances']:
            if npc['map'] != ident:
                continue
            definition = npc_definitions[npc['characterId']]
            if not definition['defaultVisible'] or definition['presence'] == 'codex-only':
                continue
            asset = read(ROOT / f'public/assets/room-npcs/{npc["characterId"]}.json')
            frame = asset['frames'][asset['animations']['idle']['frames'][0]]
            point = nearest(npc['at'], grid, npc_occupied)
            npc_occupied.add(tuple(point))
            scale = player_scale * asset['displayScale']
            image = f'assets/room-npcs/{npc["characterId"]}-idle.png'
            assert (ROOT / 'public' / image).is_file(), image
            if npc['id'] not in authored_interactions:
                npc_interactions[npc['id']] = {'text': '请选择一项操作。', 'choices': []}
            entities.append({
                'id': npc['id'], 'name': npc['name'], 'position': point,
                'character': 'sprite',
                'sprite': {
                    'image': image,
                    'size': [round(frame['w'] * scale), round(frame['h'] * scale)],
                    'anchor': [frame['anchor'][0] / frame['w'], frame['anchor'][1] / frame['h']],
                    # Match the occupied tile: source pixels may land on a reserved arrival tile.
                    'offset': [TILE // 2, TILE // 2],
                },
            })
        npc_cells = {tuple(e['position']) for e in entities if not e.get('portal')}
        walking_grid = [''.join('#' if (x, y) in npc_cells else cell for x, cell in enumerate(row))
                        for y, row in enumerate(grid)]
        for anchor in anchors.values():
            accessible = reachable(walking_grid, anchor, occupied)
            assert all(any(tuple(p) in accessible for p in tiles) for tiles in portal_tiles.values()), f'{ident}: NPC blocks an exit'
            for obj in objects:
                if 'entity' not in obj:
                    continue
                entity = obj['entity']
                x, y = entity['position']
                offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]] + entity.get('interactionOffsets', [])
                assert all(len(p) == 2 and all(type(n) is int for n in p) and 1 <= abs(p[0]) + abs(p[1]) <= 4 for p in offsets)
                assert any((x + dx, y + dy) in accessible for dx, dy in offsets), f'{entity["id"]}: unreachable interaction'
        maps[ident] = {
            'width': len(grid[0]), 'height': len(grid), 'floorTile': 271, 'wallTile': 732,
            'collision': grid, 'playerScale': player_scale, 'art': art,
        }
        scenes.append({
            'schema_version': '1.0', 'content_version': metadata[ident].get('contentVersion', recipe['contentVersion']),
            'id': ident, 'name': source['name'], 'map': {'source': f'maps/{ident}.json'},
            'anchors': anchors, 'entities': entities,
        })
    connected, queue = {recipe['start']['scene']}, deque([recipe['start']['scene']])
    while queue:
        for portal in placements[queue.popleft()]['portals']:
            target = portal['destination']['scene']
            if target not in connected:
                connected.add(target)
                queue.append(target)
    assert connected == sources.keys(), 'Disconnected rooms'
    assert len(scenes) == 26 and len(metadata['unit-404']['objects']) == 20
    package = ROOT / 'public/content/remaining-time'
    for scene in scenes:
        write(package / f'scenes/{scene["id"]}.json', scene)
        write(ROOT / f'src/content/remaining-time/maps/{scene["id"]}.json', maps[scene['id']])
    write(package / 'stories/travel.json', {
        'schema_version': '1.0', 'content_version': recipe['contentVersion'], 'id': 'room-travel',
        'vars': {}, 'interactions': interactions, 'clock': recipe['clock'],
    })
    write(package / 'stories/npcs.json', {
        'schema_version': '1.0', 'content_version': recipe['contentVersion'], 'id': 'room-npcs',
        'vars': {}, 'interactions': npc_interactions,
    })
    write(package / 'manifest.json', {
        'schema_version': '1.0', 'content_version': recipe.get('packageVersion', recipe['contentVersion']), 'start': recipe['start'],
        'scenes': [f'scenes/{s["id"]}.json' for s in scenes],
        'stories': ['stories/travel.json', 'stories/npcs.json'] + recipe.get('stories', []),
    })
    npc_count = sum(1 for scene in scenes for entity in scene['entities']
                    if entity['sprite']['image'].startswith('assets/room-npcs/'))
    print(f'Exported {len(scenes)} connected rooms, {len(interactions)} directional portals, '
          f'20 unit-404 objects, {npc_count} NPC instances.')


if __name__ == '__main__':
    export()
