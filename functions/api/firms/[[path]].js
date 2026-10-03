// /api/firms/*  →  https://firms.modaps.eosdis.nasa.gov/api/*  (แทรก MAP KEY จาก secret FIRMS_KEY)
//   area/csv/{SOURCE}/{W,S,E,N}/{DAYS}[/{DATE}]  →  area/csv/{KEY}/{SOURCE}/...
//   data_availability/csv/all                    →  data_availability/csv/{KEY}/all
import { forward, joinPath, missingSecret, text } from '../../_lib/proxy.js';

const SOURCE = '(VIIRS_SNPP|VIIRS_NOAA20|VIIRS_NOAA21|MODIS)_(NRT|SP)';
const NUM = '-?\\d+(\\.\\d+)?';
const AREA = new RegExp(`^area/csv/${SOURCE}/${NUM},${NUM},${NUM},${NUM}/[1-5](/\\d{4}-\\d{2}-\\d{2})?$`);

export async function onRequestGet({ params, env }) {
  const miss = missingSecret(env, 'FIRMS_KEY');
  if (miss) return miss;
  const path = joinPath(params);
  const key = env.FIRMS_KEY;

  if (path === 'data_availability/csv/all') {
    return forward(`https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/${key}/all`, { ttl: 3600, secret: key });
  }
  if (!AREA.test(path)) return text(400, 'path not allowed');
  // ข้อมูลมาตรฐานย้อนหลัง (SP) ไม่เปลี่ยนแล้ว แคชได้นาน; ข้อมูลล่าสุด (NRT) แคช 10 นาที
  const ttl = path.includes('_SP/') ? 86400 : 600;
  return forward(`https://firms.modaps.eosdis.nasa.gov/api/${path.replace('area/csv/', `area/csv/${key}/`)}`, { ttl, secret: key });
}
