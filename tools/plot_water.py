"""Plot data/city/water.json over the city limit and the road network: /tmp/sc/water.png (whole city) and /tmp/sc/water_river.png (the river, zoomed).
Roads grey, bridges orange, water blue, city limit red, roads in water that are not bridges/tunnels magenta circles (from tools/check_water.mjs)."""
import json, os
from PIL import Image, ImageDraw

os.makedirs('/tmp/sc', exist_ok=True)
city = json.load(open('data/city/city.json'))
water = json.load(open('data/city/water.json'))['polygons']
try:
    rep = json.load(open('/tmp/sc/water_report.json'))
except FileNotFoundError:
    rep = {'ok': [], 'bad': []}
W = city['meta']['world']; boundary = city['meta']['boundary']

def render(x0, y0, x1, y1, scale, path, roads_w=1):
    w, h = int((x1 - x0) * scale), int((y1 - y0) * scale)
    im = Image.new('RGB', (w, h), (250, 250, 246)); d = ImageDraw.Draw(im)
    P = lambda p: ((p[0] - x0) * scale, (p[1] - y0) * scale)
    for p in water:
        d.polygon([P(q) for q in p['outer']], fill=(120, 170, 225))
        for hole in p['holes']:
            d.polygon([P(q) for q in hole], fill=(250, 250, 246))
    for r in city['roads']:
        col = (235, 130, 20) if (r['bridge'] or r['layer'] > 0) else ((90, 90, 200) if r['tunnel'] else (150, 150, 150))
        d.line([P(q) for q in r['points']], fill=col, width=roads_w)
    d.line([P(q) for q in boundary + [boundary[0]]], fill=(220, 30, 30), width=max(1, roads_w))
    for b in rep['bad']:
        x, y = P(b['at']); d.ellipse([x - 10, y - 10, x + 10, y + 10], outline=(230, 0, 200), width=3)
    im.save(path)
    print(path, im.size)

render(W['minX'] - 300, W['minY'] - 300, W['maxX'] + 300, W['maxY'] + 300, 0.12, '/tmp/sc/water.png')
# zoom on downtown + the river (rotated frame: this box holds the river between the Ford bridge and Lowry)
render(-2600, -3200, 2600, 1800, 0.4, '/tmp/sc/water_river.png', 1)
