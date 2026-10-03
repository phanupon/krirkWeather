// /proxy/royalrain?station=…  →  API รายการภาพเรดาร์ของกรมฝนหลวงและการบินเกษตร
// (API ต้นทางไม่ส่ง header CORS เบราว์เซอร์จึงเรียกตรงไม่ได้ — ไม่ต้องใช้คีย์)
import { forward, text } from '../_lib/proxy.js';

const STATIONS = new Set(['omkoi', 'rongkwang', 'takhli', 'rasisalai', 'singha', 'phimai', 'banphue',
  'sattahip', 'pathio', 'phanom', 'pluakdaeng', 'all', 'all-only-latest']);

export async function onRequestGet({ request }) {
  const station = new URL(request.url).searchParams.get('station') || '';
  if (!STATIONS.has(station)) return text(400, 'unknown station');
  return forward(`https://file.royalrain.go.th/opendata/radar_data/cappi/api.php?station=${station}`, {
    ttl: 120, contentType: 'application/json; charset=utf-8',
  });
}
