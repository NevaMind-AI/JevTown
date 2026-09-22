"""Generate a local room asset catalog: python scripts/room-asset-catalog.py.

Reads the active layouts and exported scene maps; validates local asset references.
Output is ignored production material, with links to the original PNGs.
"""
import html
import json
import os
import struct
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'art/map-study/asset-catalog.html'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def local_file(path):
    path = path.resolve()
    assert path.is_relative_to(ROOT) and path.is_file(), f'Missing local file: {path}'
    return path


def link(path):
    return quote(os.path.relpath(local_file(path), OUTPUT.parent).replace('\\', '/'))


def png_size(path):
    with local_file(path).open('rb') as image:
        header = image.read(24)
    assert header[:8] == b'\x89PNG\r\n\x1a\n' and header[12:16] == b'IHDR', path
    return struct.unpack('>II', header[16:24])


def generate():
    recipe = read(ROOT / 'art/room-maps.json')
    usage = {}
    for room in recipe['scenes']:
        scene = read(ROOT / f'public/content/remaining-time/scenes/{room}.json')
        map_path = local_file(ROOT / 'src/content/remaining-time' / scene['map']['source'])
        for item in read(map_path).get('art', []):
            usage.setdefault(item['image'], set()).add(room)

    # Validate both layout variants, including optional editable-source references.
    for room in recipe['scenes']:
        for path in (ROOT / f'public/assets/{room}').glob('layout*.json'):
            layout = read(path)
            local_file(path.parent / layout['background'])
            ids = [obj['id'] for obj in layout.get('objects', [])]
            assert len(ids) == len(set(ids)), f'Duplicate IDs: {path}'
            for obj in layout.get('objects', []):
                local_file(path.parent / obj['image'])
                if obj.get('source'):
                    local_file(ROOT / obj['source'])

    cards, options = [], []
    for room in recipe['scenes']:
        folder = ROOT / f'public/assets/{room}'
        layout_path = folder / recipe.get('layoutFiles', {}).get(room, 'layout.json')
        layout = read(layout_path)
        name = layout['sourceLayout']['name']
        options.append(f'<option value="{html.escape(room, quote=True)}">{html.escape(name)} · {room}</option>')
        entries = [('background', {'id': 'background', 'image': layout['background']})]
        entries += [('prop', obj) for obj in layout.get('objects', [])]
        for kind, obj in entries:
            image = folder / obj['image']
            width, height = png_size(image)
            asset_path = f'assets/{room}/{obj["image"]}'
            used_by = sorted(usage.get(asset_path, []))
            key = f'{room}/{obj["id"]}'
            size = ' × '.join(map(str, obj.get('size', [width, height])))
            foot = ', '.join(map(str, obj['footpoint'])) if 'footpoint' in obj else '—'
            search = html.escape(f'{key} {name} {asset_path} {" ".join(used_by)}'.lower(), quote=True)
            cards.append(f'''<article data-room="{html.escape(room, quote=True)}" data-kind="{kind}" data-search="{search}">
<a class="preview" href="{link(image)}" target="_blank" rel="noopener"><img src="{link(image)}" alt="{html.escape(key, quote=True)}" loading="lazy"></a>
<h2>{html.escape(key)}</h2><p>{html.escape(name)} · {'背景' if kind == 'background' else '物件'}</p>
<p>PNG {width} × {height} px · 摆放 {html.escape(size)} px<br>局部脚点 ({html.escape(foot)}) px</p>
<p>地图引用：{html.escape('、'.join(used_by)) if used_by else '未在导出地图中引用'}</p>
<p><a href="{link(layout_path)}">布局清单</a> · <a href="{link(image)}" download>下载 PNG</a></p>
<code>{html.escape(asset_path)}</code></article>''')

    page = '''<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>房间资产图录</title>
<style>
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 24px; max-width: 1600px; font: 15px/1.6 system-ui, sans-serif; color: #202a31; background: #f3f5f6; }
h1 { margin: 0; } h2 { font-size: 15px; overflow-wrap: anywhere; }
a { color: #165d96; } p { margin: 8px 0; }
.controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: end; margin: 20px 0; }
label { display: flex; flex-direction: column; gap: 4px; }
input, select { font: inherit; padding: 8px; max-width: 100%; }
#catalog { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
article { padding: 12px; background: white; border: 1px solid #ccd3d9; border-radius: 8px; }
article[hidden] { display: none; }
.preview { display: flex; align-items: center; justify-content: center; height: 220px; background: #e2e5e9; border-radius: 4px; }
body.dark .preview { background: #20242b; }
img { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: pixelated; }
code { display: block; font-size: 12px; overflow-wrap: anywhere; user-select: all; }
@media print { .controls { display: none; } article { break-inside: avoid; } }
</style>
<h1>房间资产图录</h1>
<p>当前选用布局的背景与独立物件。缩略图按格子缩放，非统一比例；点击查看原 PNG。坐标单位为像素，脚点相对物件左上角。</p>
<p>地图引用来自已导出的场景配置，不表示已完成试玩验收。更新资产或布局后重新运行 <code style="display:inline">python scripts/room-asset-catalog.py</code>。</p>
<div class="controls">
<label>搜索 ID、房间或路径<input id="search" type="search" placeholder="例如 chair、厨房"></label>
<label>房间<select id="room"><option value="">全部房间</option>__OPTIONS__</select></label>
<label>类型<select id="kind"><option value="">全部类型</option><option value="prop">物件</option><option value="background">背景</option></select></label>
<label>预览底色<select id="background"><option value="light">浅色</option><option value="dark">深色</option></select></label>
</div>
<p id="count" role="status" aria-live="polite"></p>
<main id="catalog">__CARDS__</main>
<script>
const cards = [...document.querySelectorAll('article')];
const search = document.querySelector('#search');
const room = document.querySelector('#room');
const kind = document.querySelector('#kind');
function filter() {
  const words = search.value.trim().toLowerCase().split(/\\s+/);
  for (const card of cards) {
    card.hidden = (room.value && card.dataset.room !== room.value)
      || (kind.value && card.dataset.kind !== kind.value)
      || !words.every(word => card.dataset.search.includes(word));
  }
  document.querySelector('#count').textContent = `显示 ${cards.filter(card => !card.hidden).length} / ${cards.length} 件资产`;
}
search.addEventListener('input', filter);
room.addEventListener('change', filter);
kind.addEventListener('change', filter);
document.querySelector('#background').addEventListener('change', event => {
  document.body.classList.toggle('dark', event.target.value === 'dark');
});
filter();
</script>
</html>'''
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(page.replace('__OPTIONS__', ''.join(options)).replace('__CARDS__', '\n'.join(cards)), encoding='utf-8')
    print(f'Validated layouts and generated {len(cards)} assets: {OUTPUT}')


if __name__ == '__main__':
    generate()
