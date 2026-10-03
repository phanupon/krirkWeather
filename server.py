#!/usr/bin/env python3
"""เซิร์ฟเวอร์สำหรับรันเว็บแอปบนเครื่อง

- ให้บริการไฟล์ static (index.html, css, js)
- proxy เฉพาะ API รายการภาพเรดาร์ของกรมฝนหลวงและการบินเกษตร (file.royalrain.go.th)
  ซึ่งไม่ส่ง header CORS เบราว์เซอร์จึงเรียกตรงไม่ได้ (ตัวภาพ PNG โหลดตรงได้ตามปกติ)

ใช้งาน:  python server.py [port]   (ค่าเริ่มต้น 8080)
"""
import http.server
import json
import sys
import time
import urllib.parse
import urllib.request

ROYALRAIN_API = 'https://file.royalrain.go.th/opendata/radar_data/cappi/api.php?station={}'
# อนุญาตเฉพาะชื่อสถานีที่รู้จัก เพื่อไม่ให้ proxy ถูกใช้เรียก URL อื่น
STATIONS = {
    'omkoi', 'rongkwang', 'takhli', 'rasisalai', 'singha', 'phimai', 'banphue',
    'sattahip', 'pathio', 'phanom', 'pluakdaeng', 'all', 'all-only-latest',
}
CACHE_SECONDS = 120  # เรดาร์อัปเดตทุก 6 นาที
_cache = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == '/proxy/royalrain':
            return self.proxy_royalrain(url)
        return super().do_GET()

    def proxy_royalrain(self, url):
        station = urllib.parse.parse_qs(url.query).get('station', [''])[0]
        if station not in STATIONS:
            return self.send_error(400, 'unknown station')
        now = time.time()
        hit = _cache.get(station)
        if not hit or now - hit[0] > CACHE_SECONDS:
            try:
                with urllib.request.urlopen(ROYALRAIN_API.format(station), timeout=30) as r:
                    body = r.read()
                json.loads(body)  # ตรวจว่าเป็น JSON จริง
                hit = _cache[station] = (now, body)
            except Exception as e:  # noqa: BLE001 — ส่งข้อมูลเก่าในแคชถ้ามี
                if not hit:
                    return self.send_error(502, f'upstream error: {e}')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(hit[1])))
        self.end_headers()
        self.wfile.write(hit[1])


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Serving on http://localhost:{port}  (Ctrl+C เพื่อหยุด)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
