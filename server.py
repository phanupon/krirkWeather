#!/usr/bin/env python3
"""เซิร์ฟเวอร์สำหรับรันเว็บแอปบนเครื่อง (ทำงานแบบเดียวกับ Cloudflare Pages + Functions)

- ให้บริการไฟล์ในโฟลเดอร์ public/
- เส้นทาง proxy เดียวกับ functions/ บน Cloudflare:
    /api/waqi/*        → WAQI           (ใส่ WAQI_TOKEN)
    /api/firms/*       → NASA FIRMS     (ใส่ FIRMS_KEY)
    /api/gistda/*      → GISTDA         (ใส่ GISTDA_KEY)
    /proxy/royalrain   → กรมฝนหลวงฯ    (API ต้นทางไม่มี CORS)
- อ่านคีย์จากไฟล์ .dev.vars (รูปแบบเดียวกับ wrangler) หรือ environment variables

ใช้งาน:  python server.py [port]   (ค่าเริ่มต้น 8080)
"""
import functools
import http.server
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'


def load_dev_vars():
    """อ่าน KEY=VALUE จาก .dev.vars (environment variables มีลำดับความสำคัญสูงกว่า)"""
    env = {}
    f = ROOT / '.dev.vars'
    if f.exists():
        for line in f.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ('WAQI_TOKEN', 'FIRMS_KEY', 'GISTDA_KEY'):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


SECRETS = load_dev_vars()

# ---- กฎเดียวกับ functions/ ----
WAQI_PATH = re.compile(r'^(map/bounds|feed/(@-?\d+|geo:-?\d+(\.\d+)?;-?\d+(\.\d+)?))/?$')
FIRMS_SOURCE = r'(VIIRS_SNPP|VIIRS_NOAA20|VIIRS_NOAA21|MODIS)_(NRT|SP)'
NUM = r'-?\d+(\.\d+)?'
FIRMS_AREA = re.compile(rf'^area/csv/{FIRMS_SOURCE}/{NUM},{NUM},{NUM},{NUM}/[1-5](/\d{{4}}-\d{{2}}-\d{{2}})?$')
GISTDA_PATH = re.compile(r'^(viirs/(1day|3days|7days|30days)|burn-scar)$')
GISTDA_FILTERS = ('ct_en', 'ct_tn', 'pv_tn', 'pv_en')
STATIONS = {'omkoi', 'rongkwang', 'takhli', 'rasisalai', 'singha', 'phimai', 'banphue',
            'sattahip', 'pathio', 'phanom', 'pluakdaeng', 'all', 'all-only-latest'}

_cache = {}


class ProxyError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def need(name):
    if not SECRETS.get(name):
        raise ProxyError(500, f'ยังไม่ได้ตั้งค่า {name} ในไฟล์ .dev.vars (ดู .dev.vars.example)')
    return SECRETS[name]


def fetch(url, ttl, secret=None):
    """ดึงข้อมูลพร้อมแคชในหน่วยความจำ และลบค่า secret ออกจากผลลัพธ์"""
    now = time.time()
    hit = _cache.get(url)
    if hit and now - hit[0] < ttl:
        return hit[1:]
    try:
        with urllib.request.urlopen(url, timeout=90) as r:
            status, body, ctype = r.status, r.read(), r.headers.get('Content-Type', 'text/plain')
    except urllib.error.HTTPError as e:
        status, body, ctype = e.code, e.read(), e.headers.get('Content-Type', 'text/plain')
    except Exception as e:  # noqa: BLE001
        if hit:
            return hit[1:]
        raise ProxyError(502, f'เชื่อมต่อ API ต้นทางไม่สำเร็จ: {e}') from None
    if secret:
        body = body.replace(secret.encode(), b'REDACTED')
    if status == 200:
        _cache[url] = (now, status, body, ctype)
    return status, body, ctype


def route_waqi(path, q):
    token = need('WAQI_TOKEN')
    if not WAQI_PATH.match(path):
        raise ProxyError(400, 'path not allowed')
    up = {}
    if 'latlng' in q:
        if not re.match(r'^-?[\d.]+(,-?[\d.]+){3}$', q['latlng']):
            raise ProxyError(400, 'invalid latlng')
        up['latlng'] = q['latlng']
    if q.get('networks') == 'all':
        up['networks'] = 'all'
    up['token'] = token
    path = path.rstrip('/') + '/'
    return fetch(f'https://api.waqi.info/{path}?{urllib.parse.urlencode(up)}', 600, token)


def route_firms(path, q):
    key = need('FIRMS_KEY')
    if path == 'data_availability/csv/all':
        return fetch(f'https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{key}/all', 3600, key)
    if not FIRMS_AREA.match(path):
        raise ProxyError(400, 'path not allowed')
    ttl = 86400 if '_SP/' in path else 600
    return fetch('https://firms.modaps.eosdis.nasa.gov/api/' + path.replace('area/csv/', f'area/csv/{key}/', 1), ttl, key)


def route_gistda(path, q):
    key = need('GISTDA_KEY')
    if not GISTDA_PATH.match(path):
        raise ProxyError(400, 'path not allowed')
    try:
        limit, offset = int(q.get('limit', 1000)), int(q.get('offset', 0))
    except ValueError:
        raise ProxyError(400, 'invalid limit/offset') from None
    if not (1 <= limit <= 1000 and offset >= 0):
        raise ProxyError(400, 'invalid limit/offset')
    up = {'limit': limit, 'offset': offset, **{k: q[k] for k in GISTDA_FILTERS if q.get(k)}, 'api_key': key}
    ttl = 3600 if path == 'burn-scar' else 300
    return fetch(f'https://api-gateway.gistda.or.th/api/2.0/resources/features/{path}?{urllib.parse.urlencode(up)}', ttl, key)


def route_royalrain(q):
    station = q.get('station', '')
    if station not in STATIONS:
        raise ProxyError(400, 'unknown station')
    status, body, _ = fetch(f'https://file.royalrain.go.th/opendata/radar_data/cappi/api.php?station={station}', 120)
    return status, body, 'application/json; charset=utf-8'


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        path = urllib.parse.unquote(url.path)
        try:
            for prefix, fn in (('/api/waqi/', route_waqi), ('/api/firms/', route_firms), ('/api/gistda/', route_gistda)):
                if path.startswith(prefix):
                    return self.reply(*fn(path[len(prefix):], q))
            if path == '/proxy/royalrain':
                return self.reply(*route_royalrain(q))
        except ProxyError as e:
            return self.reply(e.status, str(e).encode(), 'text/plain; charset=utf-8')
        return super().do_GET()

    def reply(self, status, body, ctype):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    missing = [k for k in ('WAQI_TOKEN', 'FIRMS_KEY', 'GISTDA_KEY') if not SECRETS.get(k)]
    if missing:
        print(f'⚠️  ยังไม่ได้ตั้งค่า: {", ".join(missing)} — คัดลอก .dev.vars.example เป็น .dev.vars แล้วใส่คีย์')
    handler = functools.partial(Handler, directory=str(PUBLIC))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    print(f'Serving public/ on http://localhost:{port}  (Ctrl+C เพื่อหยุด)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
